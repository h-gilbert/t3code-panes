/**
 * The picker preload runs in its own JavaScript world; PageWorld.ts holds what must run in the page's.
 * Keys are comma-joined without spaces and values are literal true/false: Electron neither trims keys
 * nor reads yes/no. transparent=false paints an opaque canvas like Chrome instead of streaming black.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false,focusOnNavigation=false,transparent=false";
