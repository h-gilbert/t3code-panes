import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";

export const WorkspacePaneNavigationContext = createContext<
  ((threadRef: ScopedThreadRef) => void) | null
>(null);

export function useWorkspacePaneNavigation() {
  return useContext(WorkspacePaneNavigationContext);
}

// ChatView owns the actions; the pane owns their header position.
export const WorkspacePaneHeaderContext = createContext<HTMLDivElement | null>(null);

export function useWorkspacePaneHeader() {
  return useContext(WorkspacePaneHeaderContext);
}
