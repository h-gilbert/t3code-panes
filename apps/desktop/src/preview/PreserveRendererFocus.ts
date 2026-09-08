/** Keep a native agent click from replacing the host renderer's active editor. */
export async function preserveRendererFocus<A>(
  document: Document,
  tabId: string,
  action: () => Promise<A>,
): Promise<A> {
  const previous = document.activeElement as HTMLElement | null;
  if (!previous || previous === document.body || previous.tagName === "WEBVIEW") {
    return action();
  }
  let userMovedFocus = false;
  const onUserInput = (event: Event) => {
    if (event.isTrusted) userMovedFocus = true;
  };
  const restore = () => {
    const active = document.activeElement;
    if (
      !userMovedFocus &&
      previous.isConnected &&
      active?.tagName === "WEBVIEW" &&
      active.getAttribute("data-preview-tab") === tabId
    ) {
      previous.focus({ preventScroll: true });
    }
  };
  document.addEventListener("pointerdown", onUserInput, true);
  document.addEventListener("keydown", onUserInput, true);
  document.addEventListener("focusin", restore, true);
  try {
    return await action();
  } finally {
    restore();
    document.removeEventListener("focusin", restore, true);
    document.removeEventListener("pointerdown", onUserInput, true);
    document.removeEventListener("keydown", onUserInput, true);
  }
}
