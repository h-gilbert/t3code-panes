import { useMemo } from "react";

/** Share the rendered order between row lookups, selection, and jump shortcuts. */
export function useSidebarOrderedThreads<T>(
  pinnedThreads: readonly T[],
  visibleActiveThreads: readonly T[],
  visibleWorkingThreads: readonly T[],
  visibleSnoozedThreads: readonly T[],
  renderedSettledThreads: readonly T[],
) {
  return useMemo(
    () => [
      ...pinnedThreads,
      ...visibleActiveThreads,
      ...visibleWorkingThreads,
      ...visibleSnoozedThreads,
      ...renderedSettledThreads,
    ],
    [
      pinnedThreads,
      visibleActiveThreads,
      visibleWorkingThreads,
      visibleSnoozedThreads,
      renderedSettledThreads,
    ],
  );
}
