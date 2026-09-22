import type * as Electron from "electron";

// Register only app workspace renderers, never embedded browser pages or utility windows.
const workspaceWindows = new Map<number, Electron.BrowserWindow>();

export function registerWorkspaceWindow(window: Electron.BrowserWindow): void {
  const senderId = window.webContents.id;
  workspaceWindows.set(senderId, window);
  window.once("closed", () => workspaceWindows.delete(senderId));
}

export function workspaceWindowForSender(senderId: number): Electron.BrowserWindow | undefined {
  const window = workspaceWindows.get(senderId);
  return window && !window.isDestroyed() ? window : undefined;
}
