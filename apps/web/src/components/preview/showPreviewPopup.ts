import type { ScopedThreadRef } from "@t3tools/contracts";
import { whenPreviewTabKnown } from "~/previewStateStore";
import { showBrowserInset } from "./showBrowserInset";

export function showPreviewPopup(
  threadRef: ScopedThreadRef,
  popupTabId: string,
  _from: "panel" | "floating",
): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => showBrowserInset(threadRef, popupTabId));
}
