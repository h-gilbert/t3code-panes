import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { trackKeyboardLayout } from "./keyboardLayout";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isBrowserCaptureHost, isElectron } from "./env";
import { startAppServices, startBrowserCaptureHostServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { chunkLoadState } from "./lib/chunkReloadGuard";

const stopTrackingKeyboardLayout = trackKeyboardLayout();
import.meta.hot?.dispose(stopTrackingKeyboardLayout);

const router = isBrowserCaptureHost ? undefined : startAppServices();
if (isBrowserCaptureHost) {
  startBrowserCaptureHostServices();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = router ? <AppRoot router={router} /> : <AppRoot />;

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router ? router.load().then(whenLocaleReady) : Promise.resolve(),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (chunkLoadState.reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (chunkLoadState.reloadScheduled) return;
    throw error;
  });
