import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopPrimaryPaste from "../app/DesktopPrimaryPaste.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopBrowserCaptureHost from "./DesktopBrowserCaptureHost.ts";

function makeFakeWindow(id: number) {
  let destroyed = false;
  const closedListeners: Array<() => void> = [];
  const win = {
    excludedFromShownWindowsMenu: false,
    setIgnoreMouseEvents: vi.fn(),
    setOpacity: vi.fn(),
    setHiddenInMissionControl: vi.fn(),
    showInactive: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    isDestroyed: () => destroyed,
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      for (const listener of closedListeners) listener();
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") closedListeners.push(listener);
    }),
    webContents: {
      id,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
  return win;
}

function makeTestLayer(platform: NodeJS.Platform = "darwin") {
  const createdWindows: Array<ReturnType<typeof makeFakeWindow>> = [];
  const setBrowserCaptureHost = vi.fn();
  const baseLayer = Layer.mergeAll(
    DesktopBrowserHost.layer,
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform,
      isDevelopment: true,
      preloadPath: "/tmp/preload.js",
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.effect(
      DesktopState.DesktopState,
      Effect.map(
        Ref.make(false),
        (quitting) =>
          ({
            quitting,
          }) as unknown as DesktopState.DesktopState["Service"],
      ),
    ),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      create: () =>
        Effect.sync(() => {
          const win = makeFakeWindow(createdWindows.length + 1);
          createdWindows.push(win);
          return win as unknown as Electron.BrowserWindow;
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(PreviewManager.PreviewManager, {
      isBrowserPartition: () => true,
      prepareWebview: () => Effect.void,
      setBrowserCaptureHost: (win: Electron.BrowserWindow) =>
        Effect.sync(() => {
          setBrowserCaptureHost(win);
        }),
    } as unknown as PreviewManager.PreviewManager["Service"]),
    Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
    Layer.succeed(PreviewPasskeys.PreviewPasskeys, {
      bridgeEnabled: false,
      configure: Effect.void,
    } as unknown as PreviewPasskeys.PreviewPasskeys["Service"]),
    Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
      register: () => Effect.void,
      shutdown: Effect.void,
    } as unknown as DesktopRendererHistory.DesktopRendererHistory["Service"]),
  );
  const layer = DesktopBrowserCaptureHost.layer.pipe(Layer.provideMerge(baseLayer));
  return { layer, createdWindows, setBrowserCaptureHost };
}

describe("DesktopBrowserCaptureHost", () => {
  it.effect("stays uncreated until needed and closes after idle when not pinned", () =>
    Effect.gen(function* () {
      const { layer, createdWindows } = makeTestLayer("darwin");
      yield* Effect.gen(function* () {
        const captureHost = yield* DesktopBrowserCaptureHost.DesktopBrowserCaptureHost;
        const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
        yield* Effect.yieldNow;
        expect(createdWindows).toHaveLength(0);

        // Local backend requesting a host wakes the capture window lazily.
        yield* browserHost.handleCommandLine(JSON.stringify({ type: "ensureHost" }));
        yield* Effect.yieldNow;
        expect(createdWindows).toHaveLength(1);
        expect(createdWindows[0]!.isDestroyed()).toBe(false);

        // Pinning keeps it alive across the idle window.
        yield* captureHost.setKeepAlive(true);
        yield* TestClock.adjust("5 minutes");
        expect(createdWindows[0]!.isDestroyed()).toBe(false);

        // Unpinning while idle closes the window after the 2-minute grace period.
        yield* captureHost.setKeepAlive(false);
        yield* TestClock.adjust("1 minute");
        expect(createdWindows[0]!.isDestroyed()).toBe(false);
        yield* TestClock.adjust("1 minute");
        expect(createdWindows[0]!.isDestroyed()).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not close while a remote host environment is active", () =>
    Effect.gen(function* () {
      const { layer, createdWindows } = makeTestLayer("darwin");
      yield* Effect.gen(function* () {
        const captureHost = yield* DesktopBrowserCaptureHost.DesktopBrowserCaptureHost;
        const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
        yield* captureHost.ensure;
        expect(createdWindows).toHaveLength(1);

        yield* browserHost.connectRemote("fred");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 minutes");
        expect(createdWindows[0]!.isDestroyed()).toBe(false);

        yield* browserHost.disconnectRemote("fred");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 minutes");
        expect(createdWindows[0]!.isDestroyed()).toBe(true);
        expect(Option.isNone(Option.none())).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );
});
