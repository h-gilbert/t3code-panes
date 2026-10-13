/** Keep a native agent click from replacing the host renderer's active editor. */
// Self-contained so main can install the same guard in the host's isolated world.
export function beginRendererFocusGuard(document: Document, tabId: string): () => void {
  const previous = document.activeElement as HTMLElement | null;
  if (!previous || previous === document.body || previous.tagName === "WEBVIEW") {
    return () => {};
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
  return () => {
    restore();
    document.removeEventListener("focusin", restore, true);
    document.removeEventListener("pointerdown", onUserInput, true);
    document.removeEventListener("keydown", onUserInput, true);
  };
}

export async function preserveRendererFocus<A>(
  document: Document,
  tabId: string,
  action: () => Promise<A>,
): Promise<A> {
  const release = beginRendererFocusGuard(document, tabId);
  try {
    return await action();
  } finally {
    release();
  }
}
