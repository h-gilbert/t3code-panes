import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { showDevicePreview } from "./showDevicePreview";

function setup() {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  const ref = {
    environmentId: EnvironmentId.make("fred"),
    threadId: ThreadId.make("android-thread"),
  };
  const target = {
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android" as const,
    name: "Pixel",
  };
  const player = () =>
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, ref);
  return { ref, target, player };
}

describe("device presentation requests", () => {
  it("opens inset by default instead of leaving the device panel over it", () => {
    const { ref, target, player } = setup();
    useRightPanelStore.getState().openDevice(ref, target);
    showDevicePreview(ref, target);
    expect(player()).toMatchObject({
      source: { kind: "device", deviceId: target.deviceId },
      floating: false,
      maximized: false,
    });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
      false,
    );
  });

  it("switches fullscreen back to the same floating device and can return to inset", () => {
    const { ref, target, player } = setup();
    showDevicePreview(ref, target, "floating");
    showDevicePreview(ref, target, "fullscreen");
    expect(player()).toMatchObject({ maximized: true, floating: true });
    showDevicePreview(ref, target, "floating");
    expect(player()).toMatchObject({ maximized: false, floating: true });
    showDevicePreview(ref, target);
    expect(player()).toMatchObject({ maximized: false, floating: false });
  });

  it("hides only the requested device and can reveal it again after dismissal", () => {
    const { ref, target, player } = setup();
    showDevicePreview(ref, target);
    showDevicePreview(ref, target, "hidden");
    expect(player()).toBeNull();
    showDevicePreview(ref, target, "panel");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
      false,
    );
    expect(player()).toMatchObject({ source: { kind: "device" }, floating: false });
    showDevicePreview(ref, target);
    expect(player()?.source.kind).toBe("device");
    usePreviewMiniPlayerStore.getState().open(ref, "browser-tab");
    showDevicePreview(ref, target, "hidden");
    expect(player()?.source).toEqual({ kind: "browser", tabId: "browser-tab" });
  });
});

it("keeps physical devices out of previews without closing a browser preview", () => {
  const { ref, target, player } = setup();
  showDevicePreview(ref, target);
  showDevicePreview(ref, { ...target, physical: true });
  expect(player()).toBeNull();
  usePreviewMiniPlayerStore.getState().open(ref, "browser-tab");
  showDevicePreview(ref, { ...target, physical: true }, "fullscreen");
  expect(player()?.source).toEqual({ kind: "browser", tabId: "browser-tab" });
});
