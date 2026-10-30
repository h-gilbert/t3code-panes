import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const WORKSPACE_PANE_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const WORKSPACE_PANE_COUNT = 9;
export const DEFAULT_WORKSPACE_KEY = "main";
const WORKSPACE_PANE_STORAGE_KEY = "t3code:window-workspaces:v3";

export type WorkspacePaneCount = (typeof WORKSPACE_PANE_COUNTS)[number];
export type WorkspacePaneIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type WorkspaceLayoutMode = "grid" | "columns" | "rows";
export interface WorkspaceDraftPaneTarget {
  readonly draftId: DraftId;
}
export type WorkspacePaneTarget = ScopedThreadRef | WorkspaceDraftPaneTarget;
export type WorkspacePanes = ReadonlyArray<WorkspacePaneTarget | null>;
export type WorkspacePaneProjects = ReadonlyArray<string | null>;

const EMPTY_PANES: WorkspacePanes = Array.from({ length: WORKSPACE_PANE_COUNT }, () => null);
const EMPTY_PANE_PROJECTS: WorkspacePaneProjects = Array.from(
  { length: WORKSPACE_PANE_COUNT },
  () => null,
);

export interface ProjectWorkspaceLayout {
  panes: WorkspacePanes;
  backStacks?: ReadonlyArray<ReadonlyArray<WorkspacePaneTarget>>;
  projectKeys: WorkspacePaneProjects;
  paneCount: WorkspacePaneCount;
  layoutMode: WorkspaceLayoutMode;
  focusedPaneIndex: WorkspacePaneIndex;
  maximizedPaneIndex: WorkspacePaneIndex | null;
}

export const DEFAULT_PROJECT_WORKSPACE_LAYOUT: ProjectWorkspaceLayout = {
  panes: EMPTY_PANES,
  projectKeys: EMPTY_PANE_PROJECTS,
  paneCount: 1,
  layoutMode: "grid",
  focusedPaneIndex: 0,
  maximizedPaneIndex: null,
};

export interface WorkspacePaneState {
  layoutsByProjectKey: Record<string, ProjectWorkspaceLayout>;
  /** Projects the user removed from the pane project menu on this device. */
  hiddenPickerProjectKeys: ReadonlyArray<string>;
  revealThread: (threadRef: ScopedThreadRef, workspaceKey: string) => string;
  assignThread: (
    projectKey: string,
    threadRef: ScopedThreadRef,
    paneIndex?: WorkspacePaneIndex,
  ) => void;
  openRelatedThread: (
    workspaceKey: string,
    threadRef: ScopedThreadRef,
    paneIndex: WorkspacePaneIndex,
  ) => void;
  goBack: (workspaceKey: string, paneIndex: WorkspacePaneIndex) => void;
  assignDraft: (projectKey: string, draftId: DraftId, paneIndex?: WorkspacePaneIndex) => void;
  focusPane: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  clearPane: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  setPaneProject: (
    workspaceKey: string,
    paneIndex: WorkspacePaneIndex,
    projectKey: string | null,
  ) => void;
  toggleMaximize: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  swapPanes: (
    projectKey: string,
    fromIndex: WorkspacePaneIndex,
    toIndex: WorkspacePaneIndex,
  ) => void;
  setPaneCount: (projectKey: string, paneCount: WorkspacePaneCount) => void;
  setLayoutMode: (projectKey: string, layoutMode: WorkspaceLayoutMode) => void;
  resetWorkspace: (projectKey: string) => void;
  setPickerProjectHidden: (projectKey: string, hidden: boolean) => void;
}

export function migratePersistedWorkspacePaneState(
  persistedState: unknown,
): Pick<WorkspacePaneState, "layoutsByProjectKey"> {
  if (!persistedState || typeof persistedState !== "object") {
    return { layoutsByProjectKey: {} };
  }
  const rawLayouts = (persistedState as { layoutsByProjectKey?: unknown }).layoutsByProjectKey;
  if (!rawLayouts || typeof rawLayouts !== "object" || Array.isArray(rawLayouts)) {
    return { layoutsByProjectKey: {} };
  }

  const layoutsByProjectKey = {
    ...(rawLayouts as Record<string, ProjectWorkspaceLayout>),
  };
  for (const [storedKey, layout] of Object.entries(layoutsByProjectKey)) {
    const markerIndex = storedKey.indexOf("?workspace=");
    if (markerIndex <= 0) continue;
    const canonicalKey = storedKey.slice(0, markerIndex);
    const encodedWorkspaceKey = storedKey.slice(markerIndex + "?workspace=".length);
    let workspaceKey: string;
    try {
      workspaceKey = decodeURIComponent(encodedWorkspaceKey);
    } catch {
      continue;
    }
    if (workspaceKey !== canonicalKey) continue;

    // A previous desktop route bug duplicated the workspace query inside the
    // persisted key. That alias was the actively edited layout, so it wins
    // over any older canonical snapshot during the one-time migration.
    layoutsByProjectKey[canonicalKey] = layout;
    delete layoutsByProjectKey[storedKey];
  }
  return { layoutsByProjectKey };
}

export function assignWorkspaceThread(
  panes: WorkspacePanes,
  threadRef: ScopedThreadRef,
  paneIndex: WorkspacePaneIndex,
): { panes: WorkspacePanes; focusedPaneIndex: WorkspacePaneIndex } {
  const targetKey = scopedThreadKey(threadRef);
  const existingIndex = panes.findIndex(
    (candidate) =>
      candidate !== null && !("draftId" in candidate) && scopedThreadKey(candidate) === targetKey,
  );
  if (existingIndex >= 0) {
    return {
      panes,
      focusedPaneIndex: existingIndex as WorkspacePaneIndex,
    };
  }

  const next: Array<WorkspacePaneTarget | null> = [...panes];
  next[paneIndex] = threadRef;
  return { panes: next as unknown as WorkspacePanes, focusedPaneIndex: paneIndex };
}

// Swaps two panes' threads and projects. Focus and maximize follow the moved
// content rather than staying on the slot.
function swapWorkspaceLayoutPanes(
  layout: ProjectWorkspaceLayout,
  fromIndex: WorkspacePaneIndex,
  toIndex: WorkspacePaneIndex,
): ProjectWorkspaceLayout {
  if (fromIndex === toIndex) return layout;
  const panes = [...layout.panes];
  const projectKeys = [...layout.projectKeys];
  const backStacks = [...(layout.backStacks ?? EMPTY_PANES.map(() => []))];
  backStacks[fromIndex] = layout.backStacks?.[toIndex] ?? [];
  backStacks[toIndex] = layout.backStacks?.[fromIndex] ?? [];
  panes[fromIndex] = layout.panes[toIndex] ?? null;
  panes[toIndex] = layout.panes[fromIndex] ?? null;
  projectKeys[fromIndex] = layout.projectKeys[toIndex] ?? null;
  projectKeys[toIndex] = layout.projectKeys[fromIndex] ?? null;
  const followMove = (index: WorkspacePaneIndex) =>
    index === fromIndex ? toIndex : index === toIndex ? fromIndex : index;
  return {
    ...layout,
    panes,
    projectKeys,
    backStacks,
    focusedPaneIndex: followMove(layout.focusedPaneIndex),
    maximizedPaneIndex:
      layout.maximizedPaneIndex === null ? null : followMove(layout.maximizedPaneIndex),
  };
}

interface IndexedWorkspacePane {
  readonly originalIndex: WorkspacePaneIndex;
  readonly target: WorkspacePaneTarget | null;
  readonly projectKey: string | null;
}

export function resizeWorkspaceLayoutPaneCount(
  layout: ProjectWorkspaceLayout,
  paneCount: WorkspacePaneCount,
): ProjectWorkspaceLayout {
  if (paneCount >= layout.paneCount) {
    if (
      paneCount === layout.paneCount &&
      layout.panes.length === WORKSPACE_PANE_COUNT &&
      layout.projectKeys.length === WORKSPACE_PANE_COUNT
    ) {
      return layout;
    }

    return {
      ...layout,
      panes: Array.from(
        { length: WORKSPACE_PANE_COUNT },
        (_, index) => layout.panes[index] ?? null,
      ),
      projectKeys: Array.from({ length: WORKSPACE_PANE_COUNT }, (_, index) => {
        // Newly visible empty panes start at the project picker. Keep the
        // project for restored threads and drafts, and for visible panes.
        if (index >= layout.paneCount && index < paneCount && !layout.panes[index]) {
          return null;
        }
        return layout.projectKeys[index] ?? null;
      }),
      paneCount,
    };
  }

  const visibleSlots: IndexedWorkspacePane[] = Array.from(
    { length: layout.paneCount },
    (_, index) => ({
      originalIndex: index as WorkspacePaneIndex,
      target: layout.panes[index] ?? null,
      projectKey: layout.projectKeys[index] ?? null,
    }),
  );
  const occupiedSlots = visibleSlots.filter((slot) => slot.target !== null);
  const focusedOccupiedSlot = occupiedSlots.find(
    (slot) => slot.originalIndex === layout.focusedPaneIndex,
  );
  let retainedOccupiedSlots = occupiedSlots.slice(0, paneCount);

  // When more threads are open than the smaller layout can show, retain the
  // focused one and evict the last otherwise-retained pane. The remaining
  // occupied panes stay just beyond the visible range and reappear if the
  // workspace is expanded again.
  if (focusedOccupiedSlot !== undefined && !retainedOccupiedSlots.includes(focusedOccupiedSlot)) {
    retainedOccupiedSlots = [...retainedOccupiedSlots.slice(0, -1), focusedOccupiedSlot].sort(
      (left, right) => left.originalIndex - right.originalIndex,
    );
  }

  const retainedSet = new Set(retainedOccupiedSlots);
  const configuredEmptySlots = visibleSlots.filter(
    (slot) => slot.target === null && slot.projectKey !== null,
  );
  const blankSlots = visibleSlots.filter(
    (slot) => slot.target === null && slot.projectKey === null,
  );
  const retainedVisibleSlots = [
    ...retainedOccupiedSlots,
    ...configuredEmptySlots,
    ...blankSlots,
  ].slice(0, paneCount);
  for (const slot of retainedVisibleSlots) {
    retainedSet.add(slot);
  }

  const hiddenExistingSlots = visibleSlots.filter((slot) => !retainedSet.has(slot));
  const previouslyHiddenSlots: IndexedWorkspacePane[] = Array.from(
    { length: WORKSPACE_PANE_COUNT - layout.paneCount },
    (_, offset) => {
      const index = layout.paneCount + offset;
      return {
        originalIndex: index as WorkspacePaneIndex,
        target: layout.panes[index] ?? null,
        projectKey: layout.projectKeys[index] ?? null,
      };
    },
  );
  const reorderedSlots = [
    ...retainedVisibleSlots,
    ...hiddenExistingSlots,
    ...previouslyHiddenSlots,
  ];
  const focusedPaneIndex = retainedVisibleSlots.findIndex(
    (slot) => slot.originalIndex === layout.focusedPaneIndex,
  );
  const maximizedPaneIndex =
    layout.maximizedPaneIndex === null
      ? null
      : retainedVisibleSlots.findIndex((slot) => slot.originalIndex === layout.maximizedPaneIndex);

  return {
    ...layout,
    panes: reorderedSlots.map((slot) => slot.target),
    backStacks: reorderedSlots.map((slot) => layout.backStacks?.[slot.originalIndex] ?? []),
    projectKeys: reorderedSlots.map((slot) => slot.projectKey),
    paneCount,
    focusedPaneIndex: (focusedPaneIndex >= 0 ? focusedPaneIndex : 0) as WorkspacePaneIndex,
    maximizedPaneIndex:
      maximizedPaneIndex !== null && maximizedPaneIndex >= 0
        ? (maximizedPaneIndex as WorkspacePaneIndex)
        : null,
  };
}

function updateProjectLayout(
  state: WorkspacePaneState,
  projectKey: string,
  update: (layout: ProjectWorkspaceLayout) => ProjectWorkspaceLayout,
): Pick<WorkspacePaneState, "layoutsByProjectKey"> {
  const layouts = state.layoutsByProjectKey ?? {};
  const current = layouts[projectKey] ?? DEFAULT_PROJECT_WORKSPACE_LAYOUT;
  return {
    layoutsByProjectKey: {
      ...layouts,
      [projectKey]: update(current),
    },
  };
}

export const useWorkspacePaneStore = create<WorkspacePaneState>()(
  persist(
    (set, get) => ({
      layoutsByProjectKey: {},
      hiddenPickerProjectKeys: [],
      revealThread: (threadRef, workspaceKey) => {
        const state = get();
        const threadKey = scopedThreadKey(threadRef);
        const candidates = [
          workspaceKey,
          ...Object.keys(state.layoutsByProjectKey).filter((key) => key !== workspaceKey),
        ];
        const existingWorkspace = candidates.find((key) => {
          const layout = selectProjectWorkspaceLayout(state, key);
          return layout.panes
            .slice(0, layout.paneCount)
            .some(
              (target) => target && "threadId" in target && scopedThreadKey(target) === threadKey,
            );
        });
        const destination = existingWorkspace ?? workspaceKey;
        state.assignThread(destination, threadRef);
        return destination;
      },
      assignThread: (projectKey, threadRef, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const targetIndex = paneIndex ?? layout.focusedPaneIndex;
            const assigned = assignWorkspaceThread(
              layout.panes.slice(0, layout.paneCount),
              threadRef,
              targetIndex,
            );
            const panes = [...layout.panes];
            const backStacks = [...(layout.backStacks ?? EMPTY_PANES.map(() => []))];
            if (
              layout.panes[assigned.focusedPaneIndex] !== assigned.panes[assigned.focusedPaneIndex]
            )
              backStacks[assigned.focusedPaneIndex] = [];
            for (let i = 0; i < layout.paneCount; i++) panes[i] = assigned.panes[i] ?? null;
            for (let i = layout.paneCount; i < panes.length; i++) {
              const target = panes[i];
              if (
                target &&
                "threadId" in target &&
                scopedThreadKey(target) === scopedThreadKey(threadRef)
              ) {
                panes[i] = null;
                backStacks[i] = [];
              }
            }
            return {
              ...layout,
              ...assigned,
              panes,
              backStacks,
              maximizedPaneIndex:
                layout.maximizedPaneIndex === null ? null : assigned.focusedPaneIndex,
            };
          }),
        ),
      openRelatedThread: (workspaceKey, threadRef, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, workspaceKey, (layout) => {
            const current = layout.panes[paneIndex];
            if (
              current &&
              "threadId" in current &&
              scopedThreadKey(current) === scopedThreadKey(threadRef)
            )
              return layout;
            const panes = [...layout.panes];
            const backStacks = [...(layout.backStacks ?? EMPTY_PANES.map(() => []))];
            backStacks[paneIndex] = current
              ? [...(backStacks[paneIndex] ?? []), current].slice(-50)
              : [];
            // A related thread stays in the originating pane, even if it is also open elsewhere.
            panes[paneIndex] = threadRef;
            return { ...layout, panes, backStacks, focusedPaneIndex: paneIndex };
          }),
        ),
      goBack: (workspaceKey, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, workspaceKey, (layout) => {
            const stack = layout.backStacks?.[paneIndex] ?? [];
            const previous = stack.at(-1);
            if (!previous) return layout;
            const panes = [...layout.panes];
            const backStacks = [...(layout.backStacks ?? [])];
            panes[paneIndex] = previous;
            backStacks[paneIndex] = stack.slice(0, -1);
            return { ...layout, panes, backStacks, focusedPaneIndex: paneIndex };
          }),
        ),
      assignDraft: (projectKey, draftId, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const existingIndex = layout.panes
              .slice(0, layout.paneCount)
              .findIndex(
                (candidate) =>
                  candidate !== null && "draftId" in candidate && candidate.draftId === draftId,
              );
            const targetIndex =
              existingIndex >= 0
                ? (existingIndex as WorkspacePaneIndex)
                : (paneIndex ?? layout.focusedPaneIndex);
            const panes = [...layout.panes];
            const backStacks = [...(layout.backStacks ?? EMPTY_PANES.map(() => []))];
            if (existingIndex < 0) backStacks[targetIndex] = [];
            for (let i = layout.paneCount; i < panes.length; i++) {
              const target = panes[i];
              if (target && "draftId" in target && target.draftId === draftId) {
                panes[i] = null;
                backStacks[i] = [];
              }
            }
            panes[targetIndex] = { draftId };
            return {
              ...layout,
              panes,
              backStacks,
              focusedPaneIndex: targetIndex,
              maximizedPaneIndex: layout.maximizedPaneIndex === null ? null : targetIndex,
            };
          }),
        ),
      focusPane: (projectKey, focusedPaneIndex) => {
        // Every click inside a pane reaches this action. Avoid notifying the
        // workspace and serializing all saved layouts when focus stays put.
        if (selectProjectWorkspaceLayout(get(), projectKey).focusedPaneIndex === focusedPaneIndex)
          return;
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => ({
            ...layout,
            focusedPaneIndex,
          })),
        );
      },
      clearPane: (projectKey, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const next = [...layout.panes] as Array<WorkspacePaneTarget | null>;
            next[paneIndex] = null;
            return {
              ...layout,
              panes: next as unknown as WorkspacePanes,
              backStacks: EMPTY_PANES.map((_, i) =>
                i === paneIndex ? [] : (layout.backStacks?.[i] ?? []),
              ),
              maximizedPaneIndex:
                layout.maximizedPaneIndex === paneIndex ? null : layout.maximizedPaneIndex,
            };
          }),
        ),
      setPaneProject: (workspaceKey, paneIndex, projectKey) =>
        set((state) =>
          updateProjectLayout(state, workspaceKey, (layout) => {
            if (layout.projectKeys[paneIndex] === projectKey) return layout;
            const projectKeys = [...layout.projectKeys];
            const panes = [...layout.panes];
            projectKeys[paneIndex] = projectKey;
            panes[paneIndex] = null;
            return {
              ...layout,
              projectKeys,
              panes,
              backStacks: EMPTY_PANES.map((_, i) =>
                i === paneIndex ? [] : (layout.backStacks?.[i] ?? []),
              ),
              focusedPaneIndex: paneIndex,
              maximizedPaneIndex: null,
            };
          }),
        ),
      toggleMaximize: (projectKey, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => ({
            ...layout,
            focusedPaneIndex: paneIndex,
            maximizedPaneIndex: layout.maximizedPaneIndex === paneIndex ? null : paneIndex,
          })),
        ),
      swapPanes: (projectKey, fromIndex, toIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) =>
            swapWorkspaceLayoutPanes(layout, fromIndex, toIndex),
          ),
        ),
      setPaneCount: (projectKey, paneCount) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) =>
            resizeWorkspaceLayoutPaneCount(layout, paneCount),
          ),
        ),
      setLayoutMode: (projectKey, layoutMode) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => ({
            ...layout,
            layoutMode,
          })),
        ),
      resetWorkspace: (projectKey) =>
        set((state) => {
          const { [projectKey]: _removed, ...remaining } = state.layoutsByProjectKey ?? {};
          return { layoutsByProjectKey: remaining };
        }),
      setPickerProjectHidden: (projectKey, hidden) =>
        set((state) => {
          const isHidden = state.hiddenPickerProjectKeys.includes(projectKey);
          if (isHidden === hidden) return state;
          return {
            hiddenPickerProjectKeys: hidden
              ? [...state.hiddenPickerProjectKeys, projectKey]
              : state.hiddenPickerProjectKeys.filter((key) => key !== projectKey),
          };
        }),
    }),
    {
      name: WORKSPACE_PANE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof localStorage === "undefined" ? null : localStorage),
      ),
      partialize: ({ layoutsByProjectKey, hiddenPickerProjectKeys }) => ({
        layoutsByProjectKey,
        hiddenPickerProjectKeys,
      }),
      migrate: (persistedState) => ({
        ...migratePersistedWorkspacePaneState(persistedState),
        hiddenPickerProjectKeys: [],
      }),
    },
  ),
);

export function selectProjectWorkspaceLayout(
  state: Pick<WorkspacePaneState, "layoutsByProjectKey">,
  projectKey: string,
): ProjectWorkspaceLayout {
  return state.layoutsByProjectKey?.[projectKey] ?? DEFAULT_PROJECT_WORKSPACE_LAYOUT;
}

export function isWorkspacePath(pathname: string): boolean {
  return pathname === "/workspace" || pathname.startsWith("/workspace/");
}
