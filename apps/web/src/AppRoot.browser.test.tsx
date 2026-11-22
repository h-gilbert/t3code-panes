import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../test/render";

vi.mock(import("~/env"), async (original) => ({
  ...(await original()),
  isElectron: true,
  isBrowserCaptureHost: true,
  delegatesStreamedTabs: false,
}));

vi.mock(import("~/browser/ElectronBrowserHost"), () => ({
  ElectronBrowserHost: () => <div data-electron-browser-host="capture-host" />,
  startCaptureHostBrowserListeners: () => () => {},
  startElectronBrowserHost: () => () => {},
}));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

import { startBrowserCaptureHostServices } from "./appInit";
import { AppRoot } from "./AppRoot";

describe("AppRoot in browser capture host mode", () => {
  it("initializes i18n and mounts ElectronBrowserHost without a router", async () => {
    startBrowserCaptureHostServices();
    await using screen = await render(<AppRoot />, {
      // Capture host renders outside TanStack Router by design.
      router: false,
    });
    expect(
      screen.container.querySelector("[data-electron-browser-host='capture-host']"),
    ).not.toBeNull();
  });
});
