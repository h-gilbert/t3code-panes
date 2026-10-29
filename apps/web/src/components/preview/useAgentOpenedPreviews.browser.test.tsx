import { EnvironmentId, ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import type { ThreadPreviewState } from "~/previewStateStore";
import { useAgentOpenedPreviews } from "./useAgentOpenedPreviews";

vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => true }));

function setup() {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  const ref = { environmentId: EnvironmentId.make("fred"), threadId: ThreadId.make("android") };
  const target = {
    hostId: "local",
    deviceId: "phone",
    platform: "android" as const,
    name: "Phone",
  };
  const deviceState: DeviceServiceState = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
    devices: [{ ...target, id: target.deviceId, version: "16", booted: true, physical: false }],
    sessions: [
      {
        threadId: ref.threadId,
        hostId: "local",
        deviceId: "phone",
        platform: "android",
        openedAt: "2026-10-29T00:00:00Z",
        revealRequest: { id: "open-1", presentation: "inset" },
      },
    ],
  };
  const previewState: ThreadPreviewState = {
    snapshot: null,
    sessions: {},
    suppressedTabIds: new Set(),
    activeTabId: null,
    desktopOverlay: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    listLoaded: true,
    serverEpoch: null,
    serverRevision: 0,
  };
  function View({ loaded = true }: { loaded?: boolean }) {
    const player = usePreviewMiniPlayerStore((state) =>
      selectThreadPreviewMiniPlayer(state.byThreadKey, ref),
    );
    useAgentOpenedPreviews({
      threadRef: ref,
      deviceState,
      deviceStateLoaded: loaded,
      previewState,
      serverBrowserAvailable: false,
      miniPlayerSource: player?.source ?? null,
    });
    return <div>{player?.source.kind ?? "No preview"}</div>;
  }
  return { ref, target, View };
}

it("shows a device request already present when its thread loads", async () => {
  const { View } = setup();
  await using screen = await render(<View />);
  await expect.element(screen.getByText("device", { exact: true })).toBeVisible();
});

it("moves a restored device sidebar into the inset even before discovery finishes", async () => {
  const { View, ref, target } = setup();
  useRightPanelStore.getState().openDevice(ref, target);
  await using screen = await render(<View loaded={false} />);
  await expect.element(screen.getByText("device", { exact: true })).toBeVisible();
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
    false,
  );
});
