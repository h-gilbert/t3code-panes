import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserCredentials from "./BrowserCredentials.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

/**
 * Load tests for `nativeInputSemaphore`. Native focus is one per application, so
 * agent input across tabs is serialised; these cover the two ways that can go
 * wrong under load — dispatch windows overlapping anyway, and the permit never
 * coming back, which would wedge every agent's browser at once.
 */

const { fromId, getFocusedWebContents, webviewSend } = vi.hoisted(() => ({
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>(() => null),
  getFocusedWebContents: vi.fn<() => Electron.WebContents | null>(() => null),
  webviewSend: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn(() => null) }),
  ClipboardItem: vi.fn(),
  clipboard: { write: vi.fn(async () => undefined) },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId, getFocusedWebContents },
}));

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(
      BrowserSession.BrowserSession,
      BrowserSession.BrowserSession.of({
        getPartition: () => Effect.succeed("persist:t3code-preview-test"),
        isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
        getSession: () => Effect.die("unexpected getSession"),
        clearCookies: () => Effect.void,
        clearCache: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(BrowserCredentials.BrowserCredentials)({
      list: Effect.succeed([]),
      save: () => Effect.die("unused"),
      delete: () => Effect.void,
      resolveForFill: () => Effect.succeed({ reason: "no-credential" as const }),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
      dirname: "/tmp/t3/desktop",
      path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  ),
  Layer.provideMerge(
    FileSystem.layerNoop({ makeDirectory: () => Effect.void, remove: () => Effect.void }),
  ),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

interface DispatchWindow {
  readonly tabId: string;
  readonly phase: "enter" | "exit";
}

/** Which guest Chromium currently reports as focused, if any. */
interface NativeFocus {
  guestId: number | null;
}

/**
 * One guest per tab, reporting when its native dispatch window opens and closes,
 * and moving native focus the way a real click does so the restore guard runs.
 */
const makeGuest = (
  webContentsId: number,
  tabId: string,
  windows: Array<DispatchWindow>,
  focus: NativeFocus = { guestId: null },
  /** Holds this guest's dispatch window open until the test lets it close. */
  gate?: () => Promise<void>,
) => {
  let focusListener: (() => void) | undefined;
  let humanInput: ((_event: unknown, _signal: unknown) => void) | undefined;
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: { width: 800, height: 600 } } };
    }
    if (method === "Input.dispatchMouseEvent") {
      if (params?.type === "mousePressed") {
        windows.push({ tabId, phase: "enter" });
        focus.guestId = webContentsId;
        focusListener?.();
        humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
        // A real CDP press/release pair straddles round trips, so hand the event
        // loop over here; a gated guest holds its window open indefinitely.
        await (gate ? gate() : new Promise((resolve) => setImmediate(resolve)));
      } else {
        windows.push({ tabId, phase: "exit" });
        focus.guestId = null;
      }
    }
    return undefined;
  });
  return {
    id: webContentsId,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoading: () => false,
    isDevToolsOpened: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "focus") focusListener = listener;
    }),
    off: vi.fn((event: string) => {
      if (event === "focus") focusListener = undefined;
    }),
    ipc: {
      on: vi.fn((channel: string, listener: (_event: unknown, _signal: unknown) => void) => {
        if (channel === "preview:human-input") humanInput = listener;
      }),
      off: vi.fn(),
    },
    send: webviewSend,
    session: { on: vi.fn() },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: { isAttached: () => false, attach: vi.fn(), sendCommand, on: vi.fn(), off: vi.fn() },
  } as never;
};

describe("PreviewManager native input under load", () => {
  beforeEach(() => {
    fromId.mockReset();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    webviewSend.mockClear();
  });

  effectIt.effect("holds a second tab's dispatch until the first window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windows: Array<DispatchWindow> = [];
        const focus: NativeFocus = { guestId: null };
        let releaseFirst: (() => void) | undefined;
        const firstGate = () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        const composerWebContents = {
          id: 1,
          isDestroyed: () => false,
          focus: vi.fn(),
        } as never;
        const first = makeGuest(100, "tab_first", windows, focus, firstGate);
        const second = makeGuest(101, "tab_second", windows, focus);
        fromId.mockImplementation((id?: number) =>
          id === 100 ? first : id === 101 ? second : composerWebContents,
        );
        getFocusedWebContents.mockImplementation(() =>
          focus.guestId === 100 ? first : focus.guestId === 101 ? second : composerWebContents,
        );
        yield* manager.createTab("tab_first");
        yield* manager.registerWebview("tab_first", 100);
        yield* manager.createTab("tab_second");
        yield* manager.registerWebview("tab_second", 101);

        const firstClick = yield* manager
          .automationClick("tab_first", { x: 10, y: 10 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let tick = 0; tick < 4; tick += 1) yield* TestClock.adjust(200);
        yield* Effect.yieldNow;
        expect(windows).toEqual([{ tabId: "tab_first", phase: "enter" }]);

        // The second tab is a different guest with its own control session, so
        // only the application-wide native input permit can hold it back.
        const secondClick = yield* manager
          .automationClick("tab_second", { x: 20, y: 20 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let tick = 0; tick < 8; tick += 1) yield* TestClock.adjust(200);
        yield* Effect.yieldNow;
        expect(windows).toEqual([{ tabId: "tab_first", phase: "enter" }]);

        releaseFirst?.();
        for (let tick = 0; tick < 8; tick += 1) yield* TestClock.adjust(200);
        yield* Fiber.join(firstClick);
        yield* Fiber.join(secondClick);

        expect(windows).toEqual([
          { tabId: "tab_first", phase: "enter" },
          { tabId: "tab_first", phase: "exit" },
          { tabId: "tab_second", phase: "enter" },
          { tabId: "tab_second", phase: "exit" },
        ]);
      }),
    ),
  );

  effectIt.effect("drains a burst of clicks across tabs without leaking the permit", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const tabCount = 6;
        const clicksPerTab = 4;
        const windows: Array<DispatchWindow> = [];
        const composerFocus = vi.fn();
        const composerWebContents = {
          id: 1,
          isDestroyed: () => false,
          focus: composerFocus,
        } as never;
        const focus: NativeFocus = { guestId: null };
        const guests = new Map<number, Electron.WebContents>();
        for (let index = 0; index < tabCount; index += 1) {
          guests.set(100 + index, makeGuest(100 + index, `tab_${index}`, windows, focus));
        }
        fromId.mockImplementation((id?: number) =>
          id === 1 ? composerWebContents : (guests.get(id ?? -1) ?? null),
        );
        // The human sits in the composer; a dispatch moves focus to that guest,
        // which is what the restore guard reacts to.
        getFocusedWebContents.mockImplementation(() =>
          focus.guestId === null
            ? composerWebContents
            : (guests.get(focus.guestId) ?? composerWebContents),
        );
        for (let index = 0; index < tabCount; index += 1) {
          yield* manager.createTab(`tab_${index}`);
          yield* manager.registerWebview(`tab_${index}`, 100 + index);
        }

        // Fork from this fiber: a fork nested inside a concurrent combinator dies
        // with the transient fiber that made it.
        const clicks = [];
        for (let index = 0; index < tabCount * clicksPerTab; index += 1) {
          clicks.push(
            yield* manager
              .automationClick(`tab_${index % tabCount}`, { x: 10 + index, y: 20 })
              .pipe(Effect.forkChild({ startImmediately: true })),
          );
        }
        // Each click sleeps twice for the agent cursor, and a queued click only
        // starts sleeping once it holds the permit, so keep advancing until the
        // batch drains. A permit that never came back would hang here.
        for (let tick = 0; tick < tabCount * clicksPerTab * 4; tick += 1) {
          yield* TestClock.adjust(200);
        }
        yield* Effect.forEach(clicks, (click) => Fiber.join(click), { discard: true });

        // Every window that opened also closed, and in order: with one native
        // focus, an unclosed window means keystrokes landing in the wrong guest.
        let open: string | null = null;
        const interleaved: Array<string> = [];
        for (const entry of windows) {
          if (entry.phase === "enter") {
            if (open !== null) interleaved.push(`${open} then ${entry.tabId}`);
            open = entry.tabId;
          } else if (open === entry.tabId) {
            open = null;
          }
        }
        expect(interleaved).toEqual([]);
        expect(open).toBeNull();
        expect(windows.filter((entry) => entry.phase === "enter")).toHaveLength(
          tabCount * clicksPerTab,
        );
        // The human's caret came back after every single click.
        expect(composerFocus).toHaveBeenCalledTimes(tabCount * clicksPerTab);
      }),
    ),
  );

  effectIt.effect("keeps dispatching after a click fails inside the permit", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windows: Array<DispatchWindow> = [];
        const healthy = makeGuest(200, "tab_ok", windows);
        // This guest throws from the dispatch that runs while holding the permit.
        const failing = makeGuest(201, "tab_bad", windows) as unknown as {
          debugger: { sendCommand: ReturnType<typeof vi.fn> };
        };
        const failingSend = failing.debugger.sendCommand;
        failingSend.mockImplementation(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return { result: { value: { width: 800, height: 600 } } };
          }
          if (method === "Input.dispatchMouseEvent") throw new Error("guest went away");
          return undefined;
        });
        fromId.mockImplementation((id?: number) =>
          id === 201 ? (failing as unknown as Electron.WebContents) : healthy,
        );
        yield* manager.createTab("tab_ok");
        yield* manager.registerWebview("tab_ok", 200);
        yield* manager.createTab("tab_bad");
        yield* manager.registerWebview("tab_bad", 201);

        const failed = yield* manager
          .automationClick("tab_bad", { x: 10, y: 10 })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        for (let tick = 0; tick < 8; tick += 1) yield* TestClock.adjust(200);
        expect((yield* Fiber.join(failed))._tag).toBe("Failure");

        // The permit must have come back, or this second click never dispatches.
        const recovered = yield* manager
          .automationClick("tab_ok", { x: 20, y: 20 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let tick = 0; tick < 8; tick += 1) yield* TestClock.adjust(200);
        yield* Fiber.join(recovered);

        expect(
          windows.filter((entry) => entry.tabId === "tab_ok" && entry.phase === "enter"),
        ).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("releases the permit when a click is interrupted mid-dispatch", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windows: Array<DispatchWindow> = [];
        const guest = makeGuest(300, "tab_slow", windows);
        fromId.mockImplementation(() => guest);
        yield* manager.createTab("tab_slow");
        yield* manager.registerWebview("tab_slow", 300);

        // Interrupt before the cursor sleeps elapse, so the fiber dies while the
        // click is inside the permitted section.
        const interrupted = yield* manager
          .automationClick("tab_slow", { x: 10, y: 10 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(interrupted);

        const after = yield* manager
          .automationClick("tab_slow", { x: 30, y: 30 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let tick = 0; tick < 8; tick += 1) yield* TestClock.adjust(200);
        yield* Fiber.join(after);

        expect(windows.filter((entry) => entry.phase === "enter")).toHaveLength(1);
      }),
    ),
  );
});
