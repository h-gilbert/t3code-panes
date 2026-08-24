import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const WORKSPACE_PANE_COUNT = 8;
export const DEFAULT_WORKSPACE_KEY = "main";
const WORKSPACE_PANE_STORAGE_KEY = "t3code:window-workspaces:v3";

export type WorkspacePaneCount = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type WorkspacePaneIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
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
  assignThread: (
    projectKey: string,
    threadRef: ScopedThreadRef,
    paneIndex?: WorkspacePaneIndex,
  ) => void;
  assignDraft: (projectKey: string, draftId: DraftId, paneIndex?: WorkspacePaneIndex) => void;
  focusPane: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  clearPane: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  setPaneProject: (
    workspaceKey: string,
    paneIndex: WorkspacePaneIndex,
    projectKey: string | null,
  ) => void;
  toggleMaximize: (projectKey: string, paneIndex: WorkspacePaneIndex) => void;
  setPaneCount: (projectKey: string, paneCount: WorkspacePaneCount) => void;
  setLayoutMode: (projectKey: string, layoutMode: WorkspaceLayoutMode) => void;
  resetWorkspace: (projectKey: string) => void;
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
    return paneCount === layout.paneCount ? layout : { ...layout, paneCount };
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
    (set) => ({
      layoutsByProjectKey: {},
      assignThread: (projectKey, threadRef, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const targetIndex = paneIndex ?? layout.focusedPaneIndex;
            const assigned = assignWorkspaceThread(layout.panes, threadRef, targetIndex);
            return {
              ...layout,
              ...assigned,
              maximizedPaneIndex:
                layout.maximizedPaneIndex === null ? null : assigned.focusedPaneIndex,
            };
          }),
        ),
      assignDraft: (projectKey, draftId, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const existingIndex = layout.panes.findIndex(
              (candidate) =>
                candidate !== null && "draftId" in candidate && candidate.draftId === draftId,
            );
            const targetIndex =
              existingIndex >= 0
                ? (existingIndex as WorkspacePaneIndex)
                : (paneIndex ?? layout.focusedPaneIndex);
            const panes = [...layout.panes];
            panes[targetIndex] = { draftId };
            return {
              ...layout,
              panes,
              focusedPaneIndex: targetIndex,
              maximizedPaneIndex: layout.maximizedPaneIndex === null ? null : targetIndex,
            };
          }),
        ),
      focusPane: (projectKey, focusedPaneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => ({
            ...layout,
            focusedPaneIndex,
          })),
        ),
      clearPane: (projectKey, paneIndex) =>
        set((state) =>
          updateProjectLayout(state, projectKey, (layout) => {
            const next = [...layout.panes] as Array<WorkspacePaneTarget | null>;
            next[paneIndex] = null;
            return {
              ...layout,
              panes: next as unknown as WorkspacePanes,
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
    }),
    {
      name: WORKSPACE_PANE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof localStorage === "undefined" ? null : localStorage),
      ),
      partialize: ({ layoutsByProjectKey }) => ({ layoutsByProjectKey }),
      migrate: migratePersistedWorkspacePaneState,
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
