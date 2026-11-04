import type { ScopedThreadRef } from "@t3tools/contracts";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { setActivePreviewTab } from "~/previewStateStore";

export function showBrowserInset(threadRef: ScopedThreadRef, tabId: string): void {
  setActivePreviewTab(threadRef, tabId);
  useRightPanelStore.getState().close(threadRef, { automatic: true });
  usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
}
