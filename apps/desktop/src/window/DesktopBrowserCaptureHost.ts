import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Electron from "electron";

import * as DesktopPrimaryPaste from "../app/DesktopPrimaryPaste.ts";
import { registerCaptureRenderer } from "./workspaceWindows.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { delegatesStreamedTabs, hardenWebviewGuests } from "./webviewGuests.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-browser-capture-host");
const IDLE_CLOSE_DELAY = "2 minutes";

/**
 * A transparent, unfocusable window parked left of every display. It draws the tabs that viewers
 * stream at their full size, so the app windows' size never shrinks or blurs a streamed page.
 * Created lazily only when this desktop hosts server tabs or remote browser environments, and
 * torn down once idle so machines delegating their browser elsewhere pay zero steady-state cost.
 */
export class DesktopBrowserCaptureHost extends Context.Service<
  DesktopBrowserCaptureHost,
  {
    readonly ensure: Effect.Effect<void>;
    readonly setKeepAlive: (keepAlive: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopBrowserCaptureHost") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const previewManager = yield* PreviewManager.PreviewManager;
  const primaryPaste = yield* DesktopPrimaryPaste.DesktopPrimaryPaste;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<PreviewManager.PreviewManager>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let host: Electron.BrowserWindow | null = null;
  let keepAlive = false;
  let idleCloseFiber: Fiber.Fiber<void> | null = null;

  const cancelIdleClose = Effect.gen(function* () {
    const pending = idleCloseFiber;
    idleCloseFiber = null;
    if (pending !== null) {
      yield* Fiber.interrupt(pending);
    }
  });

  const scheduleIdleCloseIfUnused = Effect.gen(function* () {
    yield* cancelIdleClose;
    if (keepAlive || host === null || host.isDestroyed()) return;
    if (yield* browserHost.hasActiveWork) return;
    const fiber = runFork(
      Effect.sleep(IDLE_CLOSE_DELAY).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (idleCloseFiber === fiber) idleCloseFiber = null;
            if (keepAlive || host === null || host.isDestroyed()) return;
            if (yield* Ref.get(desktopState.quitting)) return;
            if (yield* browserHost.hasActiveWork) return;
            const target = host;
            host = null;
            yield* Effect.sync(() => {
              if (!target.isDestroyed()) target.close();
            });
            yield* logInfo("browser capture host closed after idle");
          }),
        ),
        Effect.ignore,
      ),
    );
    idleCloseFiber = fiber;
  });

  const ensure = Effect.gen(function* () {
    if (!delegatesStreamedTabs(environment.platform)) return;
    if (yield* Ref.get(desktopState.quitting)) return;
    yield* cancelIdleClose;
    if (host !== null && !host.isDestroyed()) {
      yield* scheduleIdleCloseIfUnused;
      return;
    }
    const window = yield* electronWindow.create(
      {
        width: 1280,
        height: 800,
        x: -20_000,
        y: 0,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: environment.preloadPath,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: true,
          disableHtmlFullscreenWindowResize: true,
        },
      },
      { auxiliary: true },
    );
    host = window;
    window.once("closed", () => {
      if (host === window) host = null;
      runFork(cancelIdleClose);
    });
    yield* Effect.sync(() => {
      window.excludedFromShownWindowsMenu = true;
      window.setIgnoreMouseEvents(true);
      window.setOpacity(0);
      // Mission Control lists every shown window, offscreen or not.
      window.setHiddenInMissionControl(true);
      registerCaptureRenderer(window);
      hardenWebviewGuests(
        window,
        previewManager,
        previewPasskeys.bridgeEnabled,
        primaryPaste.enabled,
      );
      window.webContents.on("did-attach-webview", (_event, contents) => {
        void runPromise(previewManager.prepareWebview(contents));
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
    });
    yield* rendererHistory.register(window.webContents, { surface: "browser-capture" });
    yield* previewManager.setBrowserCaptureHost(window);
    yield* Effect.sync(() => {
      void window.loadURL(
        new URL("/?browserCapture=host#/", getDesktopUrl(environment.isDevelopment)).href,
      );
      // Chromium composites guests only for a shown window; it stays transparent and offscreen.
      window.showInactive();
    });
    yield* logInfo("browser capture host created");
    yield* scheduleIdleCloseIfUnused;
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("failed to create browser capture host", { cause: String(cause) }),
    ),
    Effect.withSpan("desktop.browserCaptureHost.ensure"),
  );

  const setKeepAlive = Effect.fn("desktop.browserCaptureHost.setKeepAlive")(function* (
    nextKeepAlive: boolean,
  ) {
    keepAlive = nextKeepAlive;
    if (keepAlive) {
      yield* cancelIdleClose;
    } else {
      yield* scheduleIdleCloseIfUnused;
    }
  });

  yield* browserHost.hostRequests.pipe(
    Stream.runForEach(() => ensure),
    Effect.forkScoped,
  );

  yield* browserHost.activityChanged.pipe(
    Stream.runForEach(() => scheduleIdleCloseIfUnused),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() => cancelIdleClose);

  return DesktopBrowserCaptureHost.of({ ensure, setKeepAlive });
});

export const layer = Layer.effect(DesktopBrowserCaptureHost, make);
