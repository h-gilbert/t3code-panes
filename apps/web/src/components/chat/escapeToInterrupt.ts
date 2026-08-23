export interface EscapeToInterruptState {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly hasModifier: boolean;
  readonly isPaneFocused: boolean;
  readonly isThreadRunning: boolean;
  readonly commandPaletteOpen: boolean;
  readonly terminalFocused: boolean;
  readonly previewFocused: boolean;
  readonly modelPickerOpen: boolean;
  readonly escapeOwnedByOverlay: boolean;
  readonly focusOutsidePane: boolean;
  readonly threadSelectionActive: boolean;
}

export function shouldInterruptThreadOnEscape(state: EscapeToInterruptState): boolean {
  return (
    state.key === "Escape" &&
    !state.defaultPrevented &&
    !state.repeat &&
    !state.isComposing &&
    !state.hasModifier &&
    state.isPaneFocused &&
    state.isThreadRunning &&
    !state.commandPaletteOpen &&
    !state.terminalFocused &&
    !state.previewFocused &&
    !state.modelPickerOpen &&
    !state.escapeOwnedByOverlay &&
    !state.focusOutsidePane &&
    !state.threadSelectionActive
  );
}
