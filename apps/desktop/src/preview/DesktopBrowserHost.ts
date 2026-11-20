// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/** The manager owns the single debugger attachment; the relay shares it. */
import {
  type DesktopBrowserPrivateOperation,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type PreviewAutomationLoadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { trackDesktopDownload } from "../updates/activeDownloads.ts";
import { BrowserUploads } from "./BrowserUploads.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** The same commands as above, by method, for the relay's sends. */
const AGENT_INPUT_METHOD = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;
const AGENT_INPUT_WINDOW_MS = 5_000;
/** A viewer's pointer travelling over the stream activates nothing on the page. */
const POINTER_TRAVEL = new Set<unknown>(["mouseMoved", "mouseWheel"]);
const FOCUS_IDLE = "5 seconds";
/** How long a screenshot waits for the client to draw its guest at full detail. */
const CAPTURE_DRAW_WAIT = "1 second";
/** Well inside the server's 10 s DESKTOP_ATTACH_TIMEOUT, for a first page that never reports it is up. */
const FIRST_PAGE_TIMEOUT = "5 seconds";
const ERR_ABORTED = -3;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
  readonly environmentId?: string | undefined;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  readonly operation: (
    request: Exclude<
      DesktopBrowserPrivateOperation,
      { operation: "readDownload" | "stageUpload" | "discardUpload" }
    >,
  ) => Promise<unknown>;
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
  /** Runs after the server clears the tab's cookies, so state kept beside them goes too. */
  readonly cookiesCleared?: () => Promise<void>;
}

const keyOf = ({ environmentId, threadId, tabId }: DesktopBrowserTabKey) =>
  JSON.stringify([environmentId ?? null, threadId, tabId]);

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  screenshotTurn: object | null;
  /** Each keeps the guest painting while whoever queued it still waits, and focused while `held`. */
  readonly waitingScreenshots: Array<{
    readonly start: () => void;
    readonly live: () => boolean;
    held: boolean;
  }>;
  downloadDirectory: string | null;
  temporaryDirectory: string | null;
  readonly downloads: Set<string>;
  uploads: BrowserUploads;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  /** When the agent last drove the page with no person's input through a viewer since. */
  agentLedAt: number;
  focusEmulated: boolean;
  focusChange: Promise<void> | null;
  focusUses: number;
  /** Each pending command, by the extra session waiting on it; the main connection's have none. */
  readonly focusPending: Map<object, string | undefined>;
  /** Screenshots Chromium was sent and has not answered; each keeps its wake lock until then. */
  readonly capturing: Set<object>;
  /** Whether the client keeps the guest painting, as published on `painting`. */
  painting: boolean;
  /**
   * Driven by the agent since its thread's last turn ended or the guest last throttled. A
   * turn's start can reach us after its first command, so this holds focus once it does.
   */
  agentUsed: boolean;
  focusReleasing: boolean;
  /** The sessions sharing the guest's one Chromium screencast; it stops with the last of them. */
  readonly screencasts: Map<string | undefined, { started: boolean; pending: number }>;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
  /** Stops waiting for the first page; set until the tab is announced. */
  stopWaiting: (() => void) | null;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly remoteEvents: Stream.Stream<{
      readonly environmentId: string;
      readonly event: DesktopBrowserEventType;
    }>;
    readonly connectRemote: (environmentId: string) => Effect.Effect<void>;
    readonly disconnectRemote: (environmentId: string) => Effect.Effect<void>;
    readonly remoteCommand: (
      environmentId: string,
      command: DesktopBrowserCommand,
    ) => Effect.Effect<void>;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly loadFailed: (key: DesktopBrowserTabKey, failure: PreviewAutomationLoadError) => void;
    readonly setShown: (key: DesktopBrowserTabKey, shown: boolean | undefined) => void;
    /** Whether the client draws the guest at full detail while it is captured. */
    readonly setCaptureDrawn: (key: DesktopBrowserTabKey, drawn: boolean | undefined) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /** Whether what the page does now follows the agent's input, not a viewer's. */
    readonly agentLedPage: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** Hidden tabs that must composite a frame for the server. */
    readonly frameRequests: Stream.Stream<DesktopBrowserTabKey & { readonly active?: boolean }>;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
    /** Whether a guest needs its frames painted while the panel hides it. */
    readonly painting: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly active: boolean;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<
    DesktopBrowserEventType & { readonly environmentId?: string | undefined }
  >();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const frameRequests = yield* PubSub.unbounded<
    DesktopBrowserTabKey & { readonly active?: boolean }
  >();
  const painting = yield* PubSub.unbounded<{
    readonly key: DesktopBrowserTabKey;
    readonly active: boolean;
  }>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  /** Threads whose agent turn runs, by the server's account. */
  const agentTurns = new Set<string>();
  const emit = (event: DesktopBrowserEventType & { readonly environmentId?: string | undefined }) =>
    runFork(PubSub.publish(outbox, event));

  const turnKey = (threadId: string, environmentId?: string) =>
    JSON.stringify([environmentId ?? null, threadId]);
  // Kept apart from attachment: the renderer can show a webview before its debugger attaches,
  // and the server forgets `shown` on detach, for example while DevTools holds the debugger.
  const shownTabs = new Map<string, boolean>();
  const drawnTabs = new Set<string>();
  const drawWaiters = new Map<string, Set<() => void>>();

  const nextScreenshot = (tab: AttachedTab) => {
    tab.screenshotTurn = null;
    tab.waitingScreenshots.shift()?.start();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * Chromium below 157 crashes the whole app when a guest's renderer exits with a
   * screenshot copy in flight (crbug.com/567321049). Overlapping screenshots make that
   * far likelier, and one the server gave up on stays pending in Chromium, so each guest
   * gets one at a time. One whose relay or session has since gone is dropped unsent.
   */
  const takeScreenshot = (
    tab: AttachedTab,
    relay: CdpRelayConnection,
    ownerLive: () => boolean,
    /** Sends only while `current` holds; holds focus only while `held`. */
    capture: (current: () => boolean, held: boolean) => Promise<unknown>,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const live = () => tab.relay === relay && ownerLive();
      const waiting = {
        start: () => {
          if (!live()) {
            reject(new Error("The preview connection that asked for this screenshot closed."));
            nextScreenshot(tab);
            return;
          }
          const turn = {};
          tab.screenshotTurn = turn;
          capture(() => tab.screenshotTurn === turn && live(), waiting.held)
            .finally(() => {
              if (tab.screenshotTurn === turn) nextScreenshot(tab);
            })
            .then(resolve, reject);
        },
        live,
        held: true,
      };
      if (tab.screenshotTurn === null) waiting.start();
      else {
        // The one ahead may be abandoned mid-capture; it needs frames to finish and free its turn.
        tab.waitingScreenshots.push(waiting);
        setFocusEmulation(tab, true);
        syncPainting(tab);
      }
    });

  /**
   * Chromium counts a focus-emulated guest as captured, so a guest the panel hides would
   * never throttle. Without it, a hidden guest paints no frames and focus() fires no focus
   * events, so the guest is emulated focused while the server drives it or streams it.
   */
  const setFocusEmulation = (tab: AttachedTab, enabled: boolean) => {
    if (tab.focusEmulated === enabled) return;
    tab.focusEmulated = enabled;
    // A guest that refuses it, or a debugger already gone, behaves as unfocused.
    const change: Promise<void> = tab.debuggee.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (tab.focusChange === change) tab.focusChange = null;
      });
    tab.focusChange = change;
  };

  const waitingHolds = (tab: AttachedTab) =>
    tab.waitingScreenshots.some((waiting) => waiting.held && waiting.live());

  const releaseFocusWhenIdle = (tab: AttachedTab) => {
    if (tab.focusReleasing) return;
    tab.focusReleasing = true;
    runFork(
      Effect.gen(function* () {
        let uses: number;
        do {
          uses = tab.focusUses;
          yield* Effect.sleep(FOCUS_IDLE);
        } while (uses !== tab.focusUses);
        tab.focusReleasing = false;
        // The last pending command to settle starts another idle wait.
        if (tab.focusPending.size > 0 || tab.screencasts.size > 0 || waitingHolds(tab)) {
          return;
        }
        // The agent pauses to think between steps; its tab stays focused until the turn ends.
        if (tab.agentUsed && agentTurns.has(turnKey(tab.key.threadId, tab.key.environmentId)))
          return;
        tab.agentUsed = false;
        if (tabs.get(keyOf(tab.key)) === tab) setFocusEmulation(tab, false);
      }),
    );
  };

  /**
   * Electron composites no offscreen guest, so its screenshot or screencast waits for a frame
   * that never comes. The client paints the guest behind the app while one is pending; the
   * capture then finishes on its own, and the guest goes back offscreen once none is.
   */
  const syncPainting = (tab: AttachedTab) => {
    const active =
      tabs.get(keyOf(tab.key)) === tab &&
      (tab.screencasts.size > 0 ||
        tab.capturing.size > 0 ||
        tab.waitingScreenshots.some((waiting) => waiting.live()));
    if (tab.painting === active) return;
    tab.painting = active;
    runFork(PubSub.publish(painting, { key: tab.key, active }));
    runFork(PubSub.publish(frameRequests, { ...tab.key, active }));
  };

  /** A command may wait on the page's next frame, so the guest stays focused until it settles. */
  const holdFocus = <A>(tab: AttachedTab, owner: string | undefined, work: () => Promise<A>) => {
    const pending = {};
    tab.focusPending.set(pending, owner);
    tab.focusUses += 1;
    setFocusEmulation(tab, true);
    releaseFocusWhenIdle(tab);
    return work().finally(() => {
      if (!tab.focusPending.delete(pending)) return;
      tab.focusUses += 1;
      releaseFocusWhenIdle(tab);
    });
  };

  /**
   * A scaled guest rasters at its on-screen size until the client draws it at full detail,
   * and a screenshot taken before that copies the blurred frame. A client that cannot draw
   * (a hidden window, say) only delays the capture.
   */
  const whenDrawn = (tab: AttachedTab) =>
    new Promise<void>((resolve) => {
      const id = keyOf(tab.key);
      const waiters = drawWaiters.get(id) ?? new Set();
      drawWaiters.set(id, waiters);
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0 && drawWaiters.get(id) === waiters) drawWaiters.delete(id);
        resolve();
      };
      waiters.add(done);
      runFork(Effect.sleep(CAPTURE_DRAW_WAIT).pipe(Effect.andThen(Effect.sync(done))));
    });

  /** Chromium answers a capture, and frees its wake lock, only once the guest paints a frame. */
  const paintUntilAnswered = <A>(tab: AttachedTab, send: () => Promise<A>) => {
    const sent = {};
    tab.capturing.add(sent);
    syncPainting(tab);
    // Sent at once when already drawn, so it keeps its place among the commands after it.
    return (drawnTabs.has(keyOf(tab.key)) ? send() : whenDrawn(tab).then(send)).finally(() => {
      tab.capturing.delete(sent);
      syncPainting(tab);
    });
  };

  /**
   * Chromium can leave a command unanswered, so the screenshot guard's release points
   * also end every focus hold: a released relay has no one waiting, and a new document
   * answers nothing pending from the old one. A released relay's screencast has no viewer.
   */
  const dropFocusHolds = (tab: AttachedTab) => {
    tab.focusPending.clear();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  const dropRelay = (tab: AttachedTab) => {
    tab.relay?.dispose();
    tab.relay = null;
    tab.screencasts.clear();
    tab.agentUsed = false;
    dropFocusHolds(tab);
  };

  /** An owner that leaves without stopping would otherwise keep the screencast running unseen. */
  const leaveScreencast = (tab: AttachedTab, owner: string | undefined) => {
    if (!tab.screencasts.delete(owner) || tab.screencasts.size > 0) return;
    void tab.debuggee.debugger.sendCommand("Page.stopScreencast").catch(() => {});
  };

  /** A detached session, such as a closed viewer, waits on nothing it sent. */
  const dropSessionHolds = (tab: AttachedTab, owner: string) => {
    leaveScreencast(tab, owner);
    for (const [pending, holder] of tab.focusPending) {
      if (holder === owner) tab.focusPending.delete(pending);
    }
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * A command the server stopped waiting on, such as a timed-out screenshot or evaluation,
   * may never settle; the turn's end ends every focus hold. The agent also sends on its own extra
   * session, so this cannot spare other sessions; a viewer's screencast still holds.
   */
  const endAgentTurn = (threadId: string, environmentId?: string) => {
    agentTurns.delete(turnKey(threadId, environmentId));
    for (const tab of tabs.values()) {
      if (tab.key.threadId !== threadId || tab.key.environmentId !== environmentId) continue;
      tab.agentUsed = false;
      // Still sent in turn, so the queue keeps moving, but no longer kept focused.
      for (const waiting of tab.waitingScreenshots) waiting.held = false;
      dropFocusHolds(tab);
    }
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const send = async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      const result = await tab.debuggee.send(
        method,
        method === "DOM.setFileInputFiles" && tab.key.environmentId !== undefined
          ? { ...params, files: tab.uploads.resolve(params.files as string[]) }
          : method === "Browser.setDownloadBehavior" &&
              tab.key.environmentId !== undefined &&
              tab.downloadDirectory
            ? { ...params, downloadPath: tab.downloadDirectory }
            : params,
        sessionId,
      );
      if (method === "Network.clearBrowserCookies") await tab.debuggee.cookiesCleared?.();
      return result;
    };
    const detachedOwners = new Set<string>();
    /** Viewers and recordings stream; the agent's own sessions never do. */
    const streamingOwners = new Set<string>();
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId, owner) => {
          // A child session's screencast is not the page's, such as a late one on a detached session.
          const stream =
            sessionId === undefined && method === "Page.startScreencast"
              ? (tab.screencasts.get(owner) ?? { started: false, pending: 0 })
              : undefined;
          if (stream) {
            stream.pending += 1;
            tab.screencasts.set(owner, stream);
            if (owner !== undefined) streamingOwners.add(owner);
            syncPainting(tab);
          } else if (sessionId === undefined && method === "Page.stopScreencast") {
            tab.screencasts.delete(owner);
            syncPainting(tab);
            if (tab.screencasts.size > 0) return Promise.resolve({});
          }
          // A person's input through a viewer, or Playwright's own housekeeping, is not the agent's.
          if (AGENT_INPUT_METHOD.test(method)) {
            if (owner === undefined || !streamingOwners.has(owner)) {
              tab.agentUsed = true;
              tab.agentLedAt = performance.now();
            } else if (method.startsWith("Input.") && !POINTER_TRAVEL.has(params["type"])) {
              tab.agentLedAt = Number.NEGATIVE_INFINITY;
            }
          }
          // Waits for focus emulation; insertText and other non-CDP input would not queue behind it.
          const forward = (current?: () => boolean) => {
            const change = tab.focusChange;
            const stale = () => tab.relay !== relay || (current !== undefined && !current());
            const sendUnlessStale = () =>
              stale()
                ? Promise.reject(new Error("The page this screenshot was for has moved on."))
                : send(method, params, sessionId);
            const run = () =>
              current === undefined || stale()
                ? sendUnlessStale()
                : paintUntilAnswered(tab, sendUnlessStale);
            return change === null ? run() : change.then(run);
          };
          return method === "Page.captureScreenshot"
            ? takeScreenshot(
                tab,
                relay,
                () => owner === undefined || !detachedOwners.has(owner),
                (current, held) =>
                  held ? holdFocus(tab, owner, () => forward(current)) : forward(current),
              )
            : method === "Page.startScreencast"
              ? holdFocus(tab, owner, forward).then(
                  (result) => {
                    if (stream) {
                      stream.pending -= 1;
                      stream.started = true;
                      // A detach's stop can overtake a start still waiting on focus; nobody owns it now.
                      if (tab.screencasts.get(owner) !== stream && tab.screencasts.size === 0) {
                        void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
                      }
                    }
                    return result;
                  },
                  (cause: unknown) => {
                    if (stream) stream.pending -= 1;
                    // A viewer can outlive a refused start; its running or pending stream still holds it.
                    if (
                      stream &&
                      !stream.started &&
                      stream.pending === 0 &&
                      tab.relay === relay &&
                      tab.screencasts.get(owner) === stream
                    ) {
                      leaveScreencast(tab, owner);
                    }
                    releaseFocusWhenIdle(tab);
                    syncPainting(tab);
                    throw cause;
                  },
                )
              : holdFocus(tab, owner, forward);
        },
        sessionDetached: (owner) => {
          detachedOwners.add(owner);
          dropSessionHolds(tab, owner);
        },
        receivesScreencast: (owner) => tab.screencasts.has(owner),
        ackScreencastFrame: (frameId) =>
          void debuggee
            .sendCommand("Page.screencastFrameAck", { sessionId: frameId })
            .catch(() => {}),
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          if (tab.key.environmentId === undefined || directory === null) {
            tab.downloadDirectory = directory;
          } else {
            tab.temporaryDirectory ??= NodeFS.mkdtempSync(
              NodePath.join(NodeOS.tmpdir(), "t3-browser-download-"),
            );
            tab.downloadDirectory = tab.temporaryDirectory;
          }
        },
      },
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
      // Announcing the tab again would reconnect Playwright, and the page could
      // replay the same oversized event, so the tab stays detached.
      () => {
        if (tab.relay !== relay || tabs.get(keyOf(tab.key)) !== tab) return;
        // Disabling auto-attach detaches child sessions and releases their debugger pauses.
        void debuggee
          .sendCommand("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          })
          .catch(() => {});
        if (tab.screencasts.size > 0) {
          void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
        }
        setFocusEmulation(tab, false);
        detach(tab.key);
      },
    );
    tab.relay = relay;
    return relay;
  };

  // CDP supplies the path before this runs; otherwise Electron opens a Save dialog.
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    trackDesktopDownload(item);
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(tab.pendingDownloadGuid)) return false;
    tab.downloads.add(tab.pendingDownloadGuid);
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    tab.relay?.dispose();
    void tab.uploads.dispose().catch(() => {});
    if (tab.temporaryDirectory)
      void NodeFSP.rm(tab.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    const announced = tab.stopWaiting === null;
    tab.stopWaiting?.();
    tab.relay = null;
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    syncPainting(tab);
    if (announced) emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      screenshotTurn: null,
      waitingScreenshots: [],
      downloadDirectory: null,
      temporaryDirectory: null,
      downloads: new Set(),
      uploads: new BrowserUploads(),
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      agentLedAt: Number.NEGATIVE_INFINITY,
      focusEmulated: false,
      focusChange: null,
      focusUses: 0,
      focusPending: new Map(),
      capturing: new Set(),
      painting: false,
      agentUsed: false,
      focusReleasing: false,
      screencasts: new Map(),
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Page.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        // Before the next screenshot starts, so its own holds survive.
        tab.capturing.clear();
        dropFocusHolds(tab);
        if (tab.screenshotTurn !== null) nextScreenshot(tab);
      },
      stopWaiting: null,
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
    const announce = () => {
      emit({ type: "attached", ...key });
      const shown = shownTabs.get(id);
      if (shown !== undefined) emit({ type: "shown", ...key, shown });
    };
    if (!debuggee.webContents.isLoadingMainFrame()) {
      announce();
      return;
    }
    // Electron does not pause a guest for the debugger, so Playwright connecting during its first
    // commit builds its utility world in the discarded document and every wait on it hangs.
    const { webContents } = debuggee;
    // ERR_ABORTED is a newer navigation replacing this one, whose commit is still to come.
    const onFailLoad = (
      _event: Electron.Event,
      code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && code !== ERR_ABORTED) ready();
    };
    const ready = () => {
      if (tab.stopWaiting === null) return;
      // The manager's cleanup for a destroyed guest can still be queued behind another tab's attach.
      if (webContents.isDestroyed()) return detach(key);
      tab.stopWaiting();
      announce();
    };
    const timeout = runFork(
      Effect.sleep(FIRST_PAGE_TIMEOUT).pipe(Effect.andThen(Effect.sync(ready))),
    );
    tab.stopWaiting = () => {
      tab.stopWaiting = null;
      webContents.off("dom-ready", ready);
      webContents.off("did-stop-loading", ready);
      webContents.off("did-fail-load", onFailLoad);
      runFork(Fiber.interrupt(timeout));
    };
    webContents.on("dom-ready", ready);
    webContents.on("did-stop-loading", ready);
    webContents.on("did-fail-load", onFailLoad);
  };

  const setShown = (key: DesktopBrowserTabKey, shown: boolean | undefined) => {
    const id = keyOf(key);
    if (shown === undefined) {
      shownTabs.delete(id);
      return;
    }
    if (shownTabs.get(id) === shown) return;
    shownTabs.set(id, shown);
    if (tabs.get(id)?.stopWaiting === null) emit({ type: "shown", ...key, shown });
  };

  const setCaptureDrawn = (key: DesktopBrowserTabKey, drawn: boolean | undefined) => {
    const id = keyOf(key);
    if (!drawn) {
      drawnTabs.delete(id);
      return;
    }
    drawnTabs.add(id);
    for (const done of drawWaiters.get(id) ?? []) done();
    drawWaiters.delete(id);
  };

  const loadFailed: DesktopBrowserHost["Service"]["loadFailed"] = (key, failure) => {
    if (tabs.has(keyOf(key))) emit({ type: "loadFailed", ...key, ...failure });
  };

  const handleCommandLine = (line: string, environmentId?: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      if (command.value.type === "turn") {
        if (command.value.active) agentTurns.add(turnKey(command.value.threadId, environmentId));
        else endAgentTurn(command.value.threadId, environmentId);
        return;
      }
      const tab = tabs.get(
        keyOf({ ...command.value, ...(environmentId === undefined ? {} : { environmentId }) }),
      );
      if (!tab) return;
      if (command.value.type === "operation") {
        const { requestId, request } = command.value;
        const performOperation = async () => {
          if (request.operation === "stageUpload") return tab.uploads.stage(request);
          if (request.operation === "discardUpload") return tab.uploads.discard(request.id);
          if (request.operation !== "readDownload") return tab.debuggee.operation(request);
          if (
            !tab.temporaryDirectory ||
            !tab.downloads.has(request.guid) ||
            !Number.isSafeInteger(request.offset) ||
            request.offset < 0
          )
            throw new Error("Unknown browser download or invalid offset.");
          const path = NodePath.join(tab.temporaryDirectory, request.guid);
          const file = await NodeFSP.open(path, "r");
          try {
            const { size } = await file.stat();
            if (size > 1024 * 1024 * 1024) throw new Error("Browser download exceeds 1 GB.");
            const buffer = Buffer.alloc(256 * 1024);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, request.offset);
            const done = request.offset + bytesRead >= size;
            if (done) {
              tab.downloads.delete(request.guid);
              await NodeFSP.rm(path, { force: true });
            }
            return { data: buffer.subarray(0, bytesRead).toString("base64"), done };
          } finally {
            await file.close();
          }
        };
        void performOperation().then(
          (result) => emit({ type: "operationResult", ...tab.key, requestId, result }),
          (error: unknown) =>
            emit({
              type: "operationResult",
              ...tab.key,
              requestId,
              error: error instanceof Error ? error.message : "Desktop browser operation failed.",
            }),
        );
        return;
      }
      if (command.value.type === "pointer") {
        const { phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: tab.key, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        tab.relay?.dispose();
        dropRelay(tab);
        return;
      }
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      if (/"method"\s*:\s*"Page\.captureScreenshot"/.test(command.value.message))
        runFork(PubSub.publish(frameRequests, tab.key));
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_INPUT_WINDOW_MS;
  };

  const agentLedPage = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentLedAt <= AGENT_INPUT_WINDOW_MS;
  };

  const announceAll = Effect.suspend(() => {
    // A new backend: the old one's turns ended without telling us.
    agentTurns.clear();
    return Effect.forEach(
      [...tabs.values()].filter((tab) => tab.key.environmentId === undefined),
      (tab) => {
        dropRelay(tab);
        // Announced once its first page is up.
        if (tab.stopWaiting !== null) return Effect.void;
        const shown = shownTabs.get(keyOf(tab.key));
        return PubSub.publish(outbox, { type: "attached", ...tab.key }).pipe(
          Effect.andThen(
            shown !== undefined
              ? PubSub.publish(outbox, { type: "shown", ...tab.key, shown })
              : Effect.void,
          ),
        );
      },
      { discard: true },
    );
  });

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    frameRequests: Stream.fromPubSub(frameRequests),
    remoteEvents: Stream.fromPubSub(outbox).pipe(
      Stream.filter((event) => event.environmentId !== undefined),
      Stream.map((event) => ({ environmentId: event.environmentId!, event })),
    ),
    connectRemote: Effect.fn("DesktopBrowserHost.connectRemote")((environmentId) =>
      Effect.forEach(
        [...tabs.values()].filter((tab) => tab.key.environmentId === environmentId),
        (tab) => {
          tab.relay?.dispose();
          dropRelay(tab);
          return PubSub.publish(outbox, { type: "attached", ...tab.key });
        },
        { discard: true },
      ),
    ),
    disconnectRemote: Effect.fn("DesktopBrowserHost.disconnectRemote")((environmentId) =>
      Effect.sync(() => {
        for (const tab of tabs.values())
          if (tab.key.environmentId === environmentId) {
            tab.relay?.dispose();
            dropRelay(tab);
            void tab.uploads.dispose().catch(() => {});
            tab.uploads = new BrowserUploads();
          }
      }),
    ),
    remoteCommand: Effect.fn("DesktopBrowserHost.remoteCommand")((environmentId, command) =>
      handleCommandLine(JSON.stringify(command), environmentId),
    ),
    painting: Stream.fromPubSub(painting),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(
      Stream.filter((event) => event.environmentId === undefined),
      Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`)),
    ),
    handleCommandLine,
    attach,
    detach,
    loadFailed,
    setShown,
    setCaptureDrawn,
    placeDownload,
    humanStartedDownload,
    agentLedPage,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
