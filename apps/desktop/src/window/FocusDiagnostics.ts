type FocusAction = {
  id: string;
  name: string;
  webContentsId: number;
  startedAt: number;
  completedAt: number | null;
};

/** Records event-time evidence without retaining keys, selectors, URLs, or page content. */
export function makeFocusDiagnostics(
  now: () => number,
  emit: (record: Record<string, unknown>) => void,
) {
  let lastHumanInput: { kind: "key" | "pointer"; at: number } | null = null;
  let lastAction: FocusAction | null = null;

  const record = (event: string, details: Record<string, unknown> = {}) => {
    const observedAt = now();
    emit({
      ...details,
      event,
      observedAt,
      lastHumanInput: lastHumanInput
        ? { ...lastHumanInput, ageMs: observedAt - lastHumanInput.at }
        : null,
      lastAction: lastAction
        ? { ...lastAction, ageMs: observedAt - (lastAction.completedAt ?? lastAction.startedAt) }
        : null,
    });
  };

  return {
    record,
    humanInput(kind: "key" | "pointer") {
      // Updating a timestamp is cheap; typing does not emit a log per keystroke.
      lastHumanInput = { kind, at: now() };
    },
    startAction(action: Omit<FocusAction, "startedAt" | "completedAt">) {
      const started = { ...action, startedAt: now(), completedAt: null };
      lastAction = started;
      record("automation-start");
      return () => {
        if (lastAction !== started) return;
        lastAction = { ...started, completedAt: now() };
        record("automation-end");
      };
    },
  };
}

/** Observes native focus only; it never requests focus or prevents input. */
export function observeWindowFocus(
  window: BrowserWindow,
  diagnostics: ReturnType<typeof makeFocusDiagnostics>,
  focusedWebContentsId: () => number | null,
) {
  const webContents = window.webContents;
  const record = (event: string) =>
    diagnostics.record(event, {
      focusedWebContentsId: focusedWebContentsId(),
    });
  const windowFocused = () => record("window-focus");
  const windowBlurred = () => record("window-blur");
  const rendererFocused = () => record("renderer-focus");
  const rendererBlurred = () => record("renderer-blur");
  const keyInput = (_event: Event, input: Input) => {
    if (input.type === "keyDown") diagnostics.humanInput("key");
  };
  const mouseInput = (_event: Event, input: MouseInputEvent) => {
    if (input.type === "mouseDown") diagnostics.humanInput("pointer");
  };
  window.on("focus", windowFocused);
  window.on("blur", windowBlurred);
  webContents.on("focus", rendererFocused);
  webContents.on("blur", rendererBlurred);
  webContents.on("before-input-event", keyInput);
  webContents.on("before-mouse-event", mouseInput);
  window.once("closed", () => {
    window.off("focus", windowFocused);
    window.off("blur", windowBlurred);
    webContents.off("focus", rendererFocused);
    webContents.off("blur", rendererBlurred);
    webContents.off("before-input-event", keyInput);
    webContents.off("before-mouse-event", mouseInput);
  });
}
import type { BrowserWindow, Event, Input, MouseInputEvent } from "electron";
import * as Schema from "effect/Schema";

const FocusTarget = Schema.Struct({
  kind: Schema.Literals(["composer", "browser", "input", "other"]),
  pane: Schema.NullOr(Schema.Number),
  tabId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
});

export const RendererFocusEvidence = Schema.Struct({
  event: Schema.Literals(["focus", "blur", "focusin", "focusout"]),
  observedAt: Schema.Number,
  documentFocused: Schema.Boolean,
  target: FocusTarget,
  relatedTarget: FocusTarget,
  activeElement: FocusTarget,
  lastInput: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["key", "pointer"]),
      at: Schema.Number,
    }),
  ),
});
