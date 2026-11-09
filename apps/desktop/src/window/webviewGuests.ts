import type * as Electron from "electron";

import { PASSKEY_BRIDGE_ARGUMENT } from "../preview/GuestProtocol.ts";

/**
 * macOS composites an oversized offscreen window at full resolution, so a hidden host draws the
 * tabs viewers stream. Elsewhere closing the last window must still quit the app, so app windows
 * keep drawing them themselves.
 */
export const delegatesStreamedTabs = (platform: NodeJS.Platform) => platform === "darwin";

/** Only preview-browser partitions may attach, and their guests never get Node or the app's preload. */
export function hardenWebviewGuests(
  window: Electron.BrowserWindow,
  previewManager: { readonly isBrowserPartition: (partition: string) => boolean },
  passkeyBridgeEnabled: boolean,
): void {
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (
      typeof params.partition !== "string" ||
      !previewManager.isBrowserPartition(params.partition)
    ) {
      event.preventDefault();
      return;
    }
    webPreferences.sandbox = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = false;
    webPreferences.focusOnNavigation = false;
    webPreferences.disableHtmlFullscreenWindowResize = true;
    if (passkeyBridgeEnabled) {
      webPreferences.additionalArguments = [
        ...(webPreferences.additionalArguments ?? []),
        PASSKEY_BRIDGE_ARGUMENT,
      ];
    }
  });
}
