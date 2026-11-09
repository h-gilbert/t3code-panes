// Preload installs desktopBridge before web code runs, so module-load detection is reliable.
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

const browserCaptureRole = isElectron
  ? new URLSearchParams(window.location.search).get("browserCapture")
  : null;
/** This window is the desktop's hidden, oversized host for tabs that viewers stream. */
export const isBrowserCaptureHost = browserCaptureRole === "host";
/** The desktop's hidden host draws streamed tabs, so this window shows them as a stream. */
export const delegatesStreamedTabs = browserCaptureRole === "delegated";

export const isSecretsFeatureEnabled = ["1", "true"].includes(
  import.meta.env.T3CODE_FEATURE_SECRETS?.trim().toLowerCase() ?? "",
);
