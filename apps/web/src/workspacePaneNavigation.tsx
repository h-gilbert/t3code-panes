import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";

export const WorkspacePaneNavigationContext = createContext<
  ((threadRef: ScopedThreadRef) => void) | null
>(null);

export function useWorkspacePaneNavigation() {
  return useContext(WorkspacePaneNavigationContext);
}
