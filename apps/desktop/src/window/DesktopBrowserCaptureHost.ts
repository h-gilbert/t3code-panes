import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { delegatesStreamedTabs, hardenWebviewGuests } from "./webviewGuests.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-browser-capture-host");

/**
 * A transparent, unfocusable window parked left of every display. It draws the tabs that viewers
 * stream at their full size, so the app windows' size never shrinks or blurs a streamed page.
 */
export class DesktopBrowserCaptureHost extends Context.Service<
  DesktopBrowserCaptureHost,
  { readonly ensure: Effect.Effect<void> }
>()("@t3tools/desktop/window/DesktopBrowserCaptureHost") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<PreviewManager.PreviewManager>();
  const runPromise = Effect.runPromiseWith(context);
  let host: Electron.BrowserWindow | null = null;

  const ensure = Effect.gen(function* () {
    if (!delegatesStreamedTabs(environment.platform)) return;
    if (yield* Ref.get(desktopState.quitting)) return;
    if (host !== null && !host.isDestroyed()) return;
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
    });
    yield* Effect.sync(() => {
      window.excludedFromShownWindowsMenu = true;
      window.setIgnoreMouseEvents(true);
      window.setOpacity(0);
      hardenWebviewGuests(window, previewManager, previewPasskeys.bridgeEnabled);
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
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("failed to create browser capture host", { cause: String(cause) }),
    ),
    Effect.withSpan("desktop.browserCaptureHost.ensure"),
  );

  return DesktopBrowserCaptureHost.of({ ensure });
});

export const layer = Layer.effect(DesktopBrowserCaptureHost, make);
