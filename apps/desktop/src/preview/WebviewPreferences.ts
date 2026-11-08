/**
 * contextIsolation=false is safe only with sandbox=true, or the preload's require reaches page scripts.
 * Keys are comma-joined without spaces and values are literal true/false: Electron neither trims keys
 * nor reads yes/no. transparent=false paints an opaque canvas like Chrome instead of streaming black.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false,focusOnNavigation=false,transparent=false";
