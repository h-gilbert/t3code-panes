// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The desktop end of the desktop browser channel (see `DesktopBrowserEvent` in
 * contracts). The primary backend gets two file descriptors at spawn: this
 * service writes events for the desktop's tabs to one and reads commands from
 * the other. Each attached tab is reachable only through its `CdpRelay`.
 *
 * A tab is attached once its `<webview>` registers with a key the web app
 * gave it. The preview manager owns the tab's single debugger session and hands
 * it here; the relay shares it.
 */
import {
  type DesktopBrowserPrivateOperation,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
/** CDP commands through which an agent clicks, types, or navigates the page. */
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** How long after an agent's input a download still counts as the agent's. */
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
  readonly environmentId?: string | undefined;
}

/** A tab's debugger, as the preview manager lends it to the relay. */
export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  readonly operation: (
    request: Exclude<DesktopBrowserPrivateOperation, { operation: "readDownload" }>,
  ) => Promise<unknown>;
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
}

const keyOf = ({ environmentId, threadId, tabId }: DesktopBrowserTabKey) =>
  JSON.stringify([environmentId ?? null, threadId, tabId]);

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  temporaryDirectory: string | null;
  readonly downloads: Set<string>;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  /** When the server last sent this page input, which only an agent does. */
  agentInputAt: number;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    /**
     * Newline-delimited events for a backend's browser fd. Each run starts by
     * announcing the tabs already attached, so a restarted backend hears them.
     */
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
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /**
     * Whether a server tab's download came from the person at this desktop:
     * the server sent the page no input just before it started.
     */
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /** Points a server tab's download at the server; false for any other download. */
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
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
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  const emit = (event: DesktopBrowserEventType & { readonly environmentId?: string | undefined }) =>
    runFork(PubSub.publish(outbox, event));

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          tab.debuggee.send(
            method,
            method === "Browser.setDownloadBehavior" &&
              tab.key.environmentId !== undefined &&
              tab.downloadDirectory
              ? { ...params, downloadPath: tab.downloadDirectory }
              : params,
            sessionId,
          ),
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
      // A released relay's late replies belong to a connection that is gone.
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Saves a download from a server tab where the server's Playwright expects
   * it. Without a path Electron would open its Save dialog over the app for a
   * file the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
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
    if (tab.temporaryDirectory)
      void NodeFSP.rm(tab.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    tab.debuggee.debugger.off("message", tab.onMessage);
    emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      downloadDirectory: null,
      temporaryDirectory: null,
      downloads: new Set(),
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    emit({ type: "attached", ...key });
  };

  const handleCommandLine = (line: string, environmentId?: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(
        keyOf({ ...command.value, ...(environmentId === undefined ? {} : { environmentId }) }),
      );
      if (!tab) return;
      if (command.value.type === "operation") {
        const { requestId, request } = command.value;
        const readDownload = async () => {
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
        void readDownload().then(
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
        // A new server connection starts with a fresh relay and fresh sessions.
        tab.relay = null;
        return;
      }
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  // Read when a backend starts, not when the host is built.
  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()].filter((tab) => tab.key.environmentId === undefined),
      (tab) => {
        tab.relay = null;
        return PubSub.publish(outbox, { type: "attached", ...tab.key });
      },
      { discard: true },
    ),
  );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    remoteEvents: Stream.fromPubSub(outbox).pipe(
      Stream.filter((event) => event.environmentId !== undefined),
      Stream.map((event) => ({ environmentId: event.environmentId!, event })),
    ),
    connectRemote: (environmentId) =>
      Effect.forEach(
        [...tabs.values()].filter((tab) => tab.key.environmentId === environmentId),
        (tab) => {
          tab.relay = null;
          return PubSub.publish(outbox, { type: "attached", ...tab.key });
        },
        { discard: true },
      ),
    disconnectRemote: (environmentId) =>
      Effect.sync(() => {
        for (const tab of tabs.values())
          if (tab.key.environmentId === environmentId) tab.relay = null;
      }),
    remoteCommand: (environmentId, command) =>
      handleCommandLine(JSON.stringify(command), environmentId),
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
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
