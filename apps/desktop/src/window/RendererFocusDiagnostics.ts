import type { RendererFocusEvidence } from "./FocusDiagnostics.ts";

/** Captures DOM transfers that Electron's WebContents focus events can miss. */
export function observeRendererFocus(
  window: Window,
  report: (evidence: typeof RendererFocusEvidence.Type) => void,
  now = () => performance.timeOrigin + performance.now(),
) {
  let lastInput: typeof RendererFocusEvidence.Type.lastInput = null;
  const target = (value: EventTarget | null): typeof RendererFocusEvidence.Type.target => {
    if (!(value instanceof Element)) return { kind: "other", pane: null, tabId: null };
    const element =
      value.closest('[data-testid="composer-editor"], webview, input, textarea') ?? value;
    const paneValue = element.closest("[data-workspace-pane]")?.getAttribute("data-workspace-pane");
    const pane = paneValue == null ? null : Number(paneValue);
    return {
      kind: element.matches('[data-testid="composer-editor"]')
        ? "composer"
        : element.tagName === "WEBVIEW"
          ? "browser"
          : element.matches("input, textarea")
            ? "input"
            : "other",
      pane: pane !== null && Number.isFinite(pane) ? pane : null,
      tabId:
        element.tagName === "WEBVIEW"
          ? (element.getAttribute("data-preview-tab")?.slice(0, 1024) ?? null)
          : null,
    };
  };
  const onKey = () => {
    lastInput = { kind: "key", at: now() };
  };
  const onPointer = () => {
    lastInput = { kind: "pointer", at: now() };
  };
  const onFocus = (event: FocusEvent) => {
    report({
      event: event.type as typeof RendererFocusEvidence.Type.event,
      observedAt: now(),
      documentFocused: window.document.hasFocus(),
      target: target(event.target),
      relatedTarget: target(event.relatedTarget),
      activeElement: target(window.document.activeElement),
      lastInput,
    });
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  for (const event of ["focus", "blur", "focusin", "focusout"] as const) {
    window.addEventListener(event, onFocus, true);
  }
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
    for (const event of ["focus", "blur", "focusin", "focusout"] as const) {
      window.removeEventListener(event, onFocus, true);
    }
  };
}
