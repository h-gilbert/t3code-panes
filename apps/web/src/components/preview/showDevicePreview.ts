import type { DevicePresentation, ScopedThreadRef } from "@t3tools/contracts";
import {
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { type DeviceTabTarget, useRightPanelStore } from "~/rightPanelStore";

export function showDevicePreview(
  threadRef: ScopedThreadRef,
  target: DeviceTabTarget,
  presentation: DevicePresentation = "inset",
): void {
  const source = { kind: "device" as const, ...target };
  const key = previewMiniPlayerSourceKey(source);
  const player = usePreviewMiniPlayerStore.getState();
  const panel = useRightPanelStore.getState();
  const current = selectThreadPreviewMiniPlayer(player.byThreadKey, threadRef);
  if (presentation === "hidden") {
    if (current && previewMiniPlayerSourceKey(current.source) === key) player.close(threadRef);
    panel.closeSurface(threadRef, key);
    return;
  }
  panel.close(threadRef);
  player.open(threadRef, source);
  if (presentation !== "fullscreen")
    player.setFloating(threadRef, key, presentation === "floating");
  player.setMaximized(threadRef, key, presentation === "fullscreen");
}
