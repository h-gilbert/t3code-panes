import type { ContextMenuSource } from "@t3tools/contracts";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

// Chromium uses no button for keyboard context menus and zero clicks for keyboard activation.
export function contextMenuSourceOf(
  event: Pick<MouseEvent, "type" | "button" | "detail">,
): ContextMenuSource {
  return (event.type === "click" ? event.detail === 0 : event.button === -1) ? "keyboard" : "mouse";
}

export function consumeContextMenuTrigger(
  event: KeyboardEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
) {
  if (event.defaultPrevented) return null;
  if (
    "key" in event &&
    (event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))
  ) {
    return null;
  }

  event.preventDefault();
  event.stopPropagation();

  if ("key" in event) {
    if (event.repeat) return null;
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    return { source: "keyboard" as const, position: { x: left, y: bottom } };
  }
  const source = contextMenuSourceOf(event);
  if (event.clientX === 0 && event.clientY === 0) {
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    return { source, position: { x: left, y: bottom } };
  }
  return { source, position: { x: event.clientX, y: event.clientY } };
}
