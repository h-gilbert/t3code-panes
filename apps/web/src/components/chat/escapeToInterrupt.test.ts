import { describe, expect, it } from "vite-plus/test";
import { shouldInterruptThreadOnEscape, type EscapeToInterruptState } from "./escapeToInterrupt";

const ACTIVE_PANE_RUNNING: EscapeToInterruptState = {
  key: "Escape",
  defaultPrevented: false,
  repeat: false,
  isComposing: false,
  hasModifier: false,
  isPaneFocused: true,
  isThreadRunning: true,
  commandPaletteOpen: false,
  terminalFocused: false,
  previewFocused: false,
  modelPickerOpen: false,
  escapeOwnedByOverlay: false,
  focusOutsidePane: false,
  threadSelectionActive: false,
};

describe("Escape to interrupt", () => {
  it("interrupts only the focused pane's running thread", () => {
    expect(shouldInterruptThreadOnEscape(ACTIVE_PANE_RUNNING)).toBe(true);
    expect(shouldInterruptThreadOnEscape({ ...ACTIVE_PANE_RUNNING, isPaneFocused: false })).toBe(
      false,
    );
    expect(shouldInterruptThreadOnEscape({ ...ACTIVE_PANE_RUNNING, isThreadRunning: false })).toBe(
      false,
    );
  });

  it.each([
    ["an already handled event", { defaultPrevented: true }],
    ["a key repeat", { repeat: true }],
    ["IME composition", { isComposing: true }],
    ["a modified shortcut", { hasModifier: true }],
    ["the command palette", { commandPaletteOpen: true }],
    ["a focused terminal", { terminalFocused: true }],
    ["a focused preview", { previewFocused: true }],
    ["the model picker", { modelPickerOpen: true }],
    ["an overlay", { escapeOwnedByOverlay: true }],
    ["focus outside the pane", { focusOutsidePane: true }],
    ["a sidebar thread selection", { threadSelectionActive: true }],
  ])("leaves Escape to %s", (_label, override) => {
    expect(shouldInterruptThreadOnEscape({ ...ACTIVE_PANE_RUNNING, ...override })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldInterruptThreadOnEscape({ ...ACTIVE_PANE_RUNNING, key: "Enter" })).toBe(false);
  });
});
