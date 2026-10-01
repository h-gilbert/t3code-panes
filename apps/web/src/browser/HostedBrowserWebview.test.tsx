import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  status: vi.fn<DesktopPreviewBridge["automation"]["status"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
  resize: vi.fn(async () => ({ _tag: "Success", value: { tabId: "server-tab" } })),
  updateSnapshot: vi.fn(),
  claimTab: vi.fn<DesktopPreviewBridge["claimTab"]>(),
  ownership: (() => {
    let hostedElsewhere = false;
    const listeners = new Set<() => void>();
    return {
      get: () => hostedElsewhere,
      set: (next: boolean) => {
        hostedElsewhere = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  })(),
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.resize }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { resize: {} } }));
vi.mock("~/previewStateStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    updatePreviewServerSnapshot: mocks.updateSnapshot,
    useThreadPreviewState: () => {
      const hostedElsewhere = useSyncExternalStore(mocks.ownership.subscribe, mocks.ownership.get);
      return {
        desktopByTabId: { "server-tab": { hasWebContents: !hostedElsewhere, hostedElsewhere } },
      };
    },
  };
});
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    claimTab: mocks.claimTab,
    getPreviewConfig: mocks.getPreviewConfig,
    automation: { status: mocks.status },
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { commitBrowserViewportChange } from "./browserViewportActions";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.status.mockReset().mockResolvedValue({
    available: true,
    visible: true,
    tabId: "server-tab",
    url: null,
    title: null,
    loading: false,
  });
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.claimTab.mockReset().mockResolvedValue(true);
  mocks.ownership.set(false);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const createGuest = vi.fn((_attributes: unknown) =>
      Object.assign(new EventTarget(), { getWebContentsId: () => 41 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? createGuest(element.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(
      threadRef.environmentId,
      "work",
      undefined,
    );
    expect(createGuest).toHaveBeenCalledOnce();
    expect(createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: "persist:t3-preview-work",
        src: "https://example.com",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    // The host remains alive with no right-panel PreviewView mounted.
    const nextViewport = { _tag: "freeform", width: 960, height: 640 } as const;
    await act(async () => {
      await commitBrowserViewportChange(runtimeTabId, nextViewport);
    });
    expect(mocks.resize).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId: "server-tab", viewport: nextViewport },
    });
    expect(mocks.updateSnapshot).toHaveBeenCalledWith(threadRef, { tabId: "server-tab" });
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("HostedBrowserWebview recovery", () => {
  async function mountTab() {
    vi.useFakeTimers();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const guests: Array<EventTarget & { getWebContentsId: () => number }> = [];
    const guestAttributes: Array<Record<string, unknown>> = [];
    const runtimeTabId = "recovery-tab";
    await act(async () => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={{
            environmentId: EnvironmentId.make("recovery-environment"),
            threadId: ThreadId.make("recovery-thread"),
          }}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com/current"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: (element) => {
            if (element.type !== "webview") {
              return { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined };
            }
            const id = 41 + guests.length;
            const guest = Object.assign(new EventTarget(), { getWebContentsId: () => id });
            guests.push(guest);
            guestAttributes.push(element.props as Record<string, unknown>);
            return guest;
          },
        },
      );
    });
    return { guests, guestAttributes, runtimeTabId };
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("recreates a dead retained guest when automation uses it, without a crash event", async () => {
    const { guests, guestAttributes, runtimeTabId } = await mountTab();
    let registeredId = 41;
    mocks.status.mockImplementation(async () => ({
      available: registeredId === 42,
      visible: true,
      tabId: runtimeTabId,
      url: null,
      title: null,
      loading: false,
    }));
    mocks.registerWebview.mockImplementation(async (_tabId, id) => {
      if (id === 41) throw new Error("Guest was destroyed");
      registeredId = id;
    });
    await act(() => {
      useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    await advance(1_000);
    await advance(250);
    expect(guests).toHaveLength(2);
    expect(registeredId).toBe(42);
    expect(guestAttributes[1]).toMatchObject({
      src: "https://example.com/current",
      partition: "persist:t3-preview-work",
    });
    expect(mocks.closeTab).not.toHaveBeenCalled();
    await advance(10_000);
    expect(guests).toHaveLength(2);
    expect(await mocks.status(runtimeTabId)).toMatchObject({ available: true });
  });

  it("leaves a tab to the window that owns it and takes it back with a fresh guest", async () => {
    mocks.ownership.set(true);
    vi.stubGlobal("document", { hasFocus: () => true });
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());
    const { guests, guestAttributes, runtimeTabId } = await mountTab();
    expect(guests).toHaveLength(0);
    expect(mocks.createTab).toHaveBeenCalledOnce();

    // Showing the tab in the focused window moves it here.
    const owner = Symbol();
    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, owner, { x: 0, y: 0, width: 800, height: 600 }, true, 0, 30);
    });
    expect(mocks.claimTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);

    await act(() => mocks.ownership.set(false));
    await advance(0);
    expect(guests).toHaveLength(1);
    expect(guestAttributes[0]).toMatchObject({ src: "https://example.com/current" });
    expect(mocks.registerWebview).toHaveBeenLastCalledWith(runtimeTabId, 41);
  });

  it("repairs missing registration without replacing the live page", async () => {
    const { guests, runtimeTabId } = await mountTab();
    let available = false;
    mocks.status.mockImplementation(async () => ({
      available,
      visible: true,
      tabId: runtimeTabId,
      url: null,
      title: null,
      loading: false,
    }));
    mocks.registerWebview.mockImplementation(async () => {
      available = true;
    });
    await act(() => {
      useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    await advance(10_000);
    expect(available).toBe(true);
    expect(guests).toHaveLength(1);
  });

  it("checks a manually shown tab once without continually polling a healthy page", async () => {
    const { guests, runtimeTabId } = await mountTab();
    const owner = Symbol();
    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, owner, { x: 0, y: 0, width: 800, height: 600 }, true, 0, 30);
    });
    await advance(60_000);
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(guests).toHaveLength(1);
  });

  it("keeps crash recovery scheduled when automation activity ends", async () => {
    const { guests, runtimeTabId } = await mountTab();
    let release: (() => void) | undefined;
    await act(() => {
      release = useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    await act(() => {
      guests[0]?.dispatchEvent(new Event("render-process-gone"));
    });
    await act(() => {
      release?.();
    });
    await advance(250);
    expect(guests).toHaveLength(2);
    expect(mocks.registerWebview).toHaveBeenLastCalledWith(runtimeTabId, 42);
  });

  it("does not reload a page when the desktop status request fails", async () => {
    const { guests, runtimeTabId } = await mountTab();
    mocks.status.mockRejectedValue(new Error("IPC unavailable"));
    await act(() => {
      useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    await advance(10_000);
    expect(guests).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith("Preview browser guest health check failed", {
      runtimeTabId,
    });
  });

  it("bounds repeated failed recovery and cancels recovery when the tab unmounts", async () => {
    const { guests, runtimeTabId } = await mountTab();
    mocks.status.mockResolvedValue({
      available: false,
      visible: true,
      tabId: runtimeTabId,
      url: null,
      title: null,
      loading: false,
    });
    mocks.registerWebview.mockRejectedValue(new Error("Guest was destroyed"));
    await act(() => {
      useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    for (const delay of [250, 500, 1_000]) {
      await advance(1_000);
      await advance(delay);
    }
    await advance(60_000);
    expect(guests).toHaveLength(4);
    expect(console.warn).toHaveBeenCalledWith(
      "Preview browser guest recovery",
      expect.objectContaining({ exhausted: true }),
    );
    await act(() => {
      guests.at(-1)?.dispatchEvent(new Event("render-process-gone"));
    });
    await act(() => {
      renderer?.unmount();
      renderer = undefined;
    });
    await advance(10_000);
    expect(guests).toHaveLength(4);
  });
});
