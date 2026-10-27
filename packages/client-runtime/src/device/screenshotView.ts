// @effect-diagnostics globalDate:off - This browser screenshot view runs without an Effect runtime.
import type { DeviceStreamClient, DeviceStreamEvents, DeviceStreamTarget } from "./stream.ts";
import { withDeviceHubQuery } from "./hubAccess.ts";

const noInput = () => undefined;

export function createScreenshotView(
  target: DeviceStreamTarget,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  let image: HTMLImageElement | null = null;
  let url: string | null = null;
  const loaded = () => {
    if (!image || !url) return;
    events.onScreen({
      width: image.naturalWidth,
      height: image.naturalHeight,
      orientation: image.naturalWidth > image.naturalHeight ? "landscape_left" : "portrait",
    });
    events.onStatus("streaming", "Screenshot only. The agent can control this physical device.");
  };
  const failed = () =>
    events.onStatus(
      "error",
      "Could not capture this physical device. Open an app through agent-device, then refresh the screenshot.",
    );
  const detach = () => {
    image?.removeEventListener("load", loaded);
    image?.removeEventListener("error", failed);
  };
  return {
    start: () => {
      events.onStatus("connecting");
      events.onInputConnected(false, "Screenshot only. Use the agent to control this device.");
      const vendor = target.platform === "ios" ? "serve-sim" : "serve-emu";
      url = withDeviceHubQuery(
        `${target.access.httpBase}/vendor/${vendor}/api/screenshot?device=${encodeURIComponent(target.deviceId)}&capture=${Date.now()}`,
        target.access,
      );
      events.onMjpegFallback(url);
      if (image) image.src = url;
    },
    stop: () => {
      url = null;
      detach();
    },
    setMjpegImage: (next) => {
      detach();
      image = next;
      if (!image) return;
      image.addEventListener("load", loaded);
      image.addEventListener("error", failed);
      if (url) image.src = url;
    },
    sendTouch: noInput,
    sendKey: noInput,
    sendText: noInput,
    pressButton: noInput,
    rotate: noInput,
    setOrientation: noInput,
    controlDuo: noInput,
    setDuoPanels: noInput,
    sendRawTouch: noInput,
  };
}
