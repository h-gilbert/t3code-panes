import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  DEFAULT_PROJECT_WORKSPACE_LAYOUT,
  WORKSPACE_PANE_COUNT,
  assignWorkspaceThread,
  isWorkspacePath,
  migratePersistedWorkspacePaneState,
  resizeWorkspaceLayoutPaneCount,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
  type WorkspacePanes,
} from "./workspacePaneStore";

const EMPTY_PANES = Array.from(
  { length: WORKSPACE_PANE_COUNT },
  () => null,
) as unknown as WorkspacePanes;

describe("pane focus", () => {
  it("does not notify or persist when clicking the already focused pane", () => {
    const workspaceKey = "focus-performance-test";
    const storage = useWorkspacePaneStore.persist.getOptions().storage!;
    const persist = vi.spyOn(storage, "setItem");
    const notify = vi.fn();
    const unsubscribe = useWorkspacePaneStore.subscribe(notify);
    try {
      useWorkspacePaneStore.getState().focusPane(workspaceKey, 0);
      expect(notify).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();

      useWorkspacePaneStore.getState().focusPane(workspaceKey, 2);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(
        selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), workspaceKey)
          .focusedPaneIndex,
      ).toBe(2);

      useWorkspacePaneStore.getState().focusPane(workspaceKey, 2);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      persist.mockRestore();
      useWorkspacePaneStore.getState().resetWorkspace(workspaceKey);
    }
  });
});

describe("hidden pane menu projects", () => {
  it("hides a project and restores it", () => {
    const { setPickerProjectHidden } = useWorkspacePaneStore.getState();
    try {
      setPickerProjectHidden("project-a", true);
      setPickerProjectHidden("project-a", true);
      setPickerProjectHidden("project-b", true);
      expect(useWorkspacePaneStore.getState().hiddenPickerProjectKeys).toEqual([
        "project-a",
        "project-b",
      ]);

      setPickerProjectHidden("project-a", false);
      expect(useWorkspacePaneStore.getState().hiddenPickerProjectKeys).toEqual(["project-b"]);
    } finally {
      setPickerProjectHidden("project-a", false);
      setPickerProjectHidden("project-b", false);
    }
  });
});

describe("assignWorkspaceThread", () => {
  it("assigns a thread to the requested pane", () => {
    const threadRef = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const result = assignWorkspaceThread(EMPTY_PANES, threadRef, 3);

    expect(result.panes[3]).toEqual(threadRef);
    expect(result.focusedPaneIndex).toBe(3);
    expect(EMPTY_PANES[3]).toBeNull();
  });

  it("focuses an existing pane instead of duplicating a thread", () => {
    const threadRef = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const initial = assignWorkspaceThread(EMPTY_PANES, threadRef, 4).panes;
    const result = assignWorkspaceThread(initial, threadRef, 1);

    expect(result.panes).toBe(initial);
    expect(result.focusedPaneIndex).toBe(4);
  });
});

describe("isWorkspacePath", () => {
  it("only matches the workspace route", () => {
    expect(isWorkspacePath("/workspace")).toBe(true);
    expect(isWorkspacePath("/workspace/layout")).toBe(true);
    expect(isWorkspacePath("/environment/thread")).toBe(false);
  });
});

describe("migratePersistedWorkspacePaneState", () => {
  it("moves the duplicated desktop workspace key back to its canonical key", () => {
    const staleLayout = { ...DEFAULT_PROJECT_WORKSPACE_LAYOUT, paneCount: 2 as const };
    const activeLayout = { ...DEFAULT_PROJECT_WORKSPACE_LAYOUT, paneCount: 4 as const };

    expect(
      migratePersistedWorkspacePaneState({
        layoutsByProjectKey: {
          main: staleLayout,
          "main?workspace=main": activeLayout,
        },
      }).layoutsByProjectKey,
    ).toEqual({ main: activeLayout });
  });

  it("leaves unrelated named workspaces intact", () => {
    const layout = { ...DEFAULT_PROJECT_WORKSPACE_LAYOUT, paneCount: 3 as const };

    expect(
      migratePersistedWorkspacePaneState({
        layoutsByProjectKey: { "window-a": layout },
      }).layoutsByProjectKey,
    ).toEqual({ "window-a": layout });
  });
});

describe("window workspace layouts", () => {
  it("starts a new window workspace with one pane", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });

    expect(
      selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "new-window").paneCount,
    ).toBe(1);
  });

  it("keeps pane counts, layouts, and assignments independent between windows", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const firstThread = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const secondThread = scopeThreadRef(
      "environment-1" as EnvironmentId,
      ThreadId.make("thread-2"),
    );

    const actions = useWorkspacePaneStore.getState();
    actions.setPaneCount("window-a", 6);
    actions.setLayoutMode("window-a", "columns");
    actions.assignThread("window-a", firstThread, 5);
    actions.setPaneCount("window-b", 8);
    actions.assignThread("window-b", secondThread, 7);

    const state = useWorkspacePaneStore.getState();
    const windowA = selectProjectWorkspaceLayout(state, "window-a");
    const windowB = selectProjectWorkspaceLayout(state, "window-b");

    expect(windowA.paneCount).toBe(6);
    expect(windowA.layoutMode).toBe("columns");
    expect(windowA.panes[5]).toEqual(firstThread);
    expect(windowB.paneCount).toBe(8);
    expect(windowB.panes[7]).toEqual(secondThread);
    expect(selectProjectWorkspaceLayout(state, "window-c")).toEqual(
      DEFAULT_PROJECT_WORKSPACE_LAYOUT,
    );
  });

  it("adds a ninth slot when expanding an older eight-pane workspace", () => {
    const olderLayout = {
      ...DEFAULT_PROJECT_WORKSPACE_LAYOUT,
      panes: DEFAULT_PROJECT_WORKSPACE_LAYOUT.panes.slice(0, 8),
      projectKeys: DEFAULT_PROJECT_WORKSPACE_LAYOUT.projectKeys.slice(0, 8),
      paneCount: 8 as const,
    };

    const expanded = resizeWorkspaceLayoutPaneCount(olderLayout, 9);

    expect(expanded.paneCount).toBe(9);
    expect(expanded.panes).toHaveLength(9);
    expect(expanded.projectKeys).toHaveLength(9);
    expect(expanded.panes[8]).toBeNull();
    expect(expanded.projectKeys[8]).toBeNull();
  });

  it("assigns one project to a pane and clears its previous thread", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const thread = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const actions = useWorkspacePaneStore.getState();
    actions.assignThread("window-a", thread, 2);
    actions.setPaneProject("window-a", 2, "directory-project-key");

    const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "window-a");
    expect(layout.projectKeys[2]).toBe("directory-project-key");
    expect(layout.panes[2]).toBeNull();
  });

  it("keeps a new-thread draft inside its assigned pane", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const actions = useWorkspacePaneStore.getState();
    actions.assignDraft("window-a", "draft-1" as DraftId, 2);

    const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "window-a");
    expect(layout.panes[2]).toEqual({ draftId: "draft-1" });
    expect(layout.focusedPaneIndex).toBe(2);
  });

  it("clears a thread or draft while retaining the pane's selected project", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const actions = useWorkspacePaneStore.getState();
    actions.setPaneProject("window-a", 2, "directory-project-key");
    actions.assignDraft("window-a", "draft-1" as DraftId, 2);
    actions.clearPane("window-a", 2);

    const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "window-a");
    expect(layout.projectKeys[2]).toBe("directory-project-key");
    expect(layout.panes[2]).toBeNull();
  });

  it("keeps different drafts for the same project in separate panes", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const actions = useWorkspacePaneStore.getState();
    actions.setPaneProject("window-a", 0, "directory-project-key");
    actions.assignDraft("window-a", "draft-1" as DraftId, 0);
    actions.setPaneProject("window-a", 1, "directory-project-key");
    actions.assignDraft("window-a", "draft-2" as DraftId, 1);

    const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "window-a");
    expect(layout.projectKeys.slice(0, 2)).toEqual([
      "directory-project-key",
      "directory-project-key",
    ]);
    expect(layout.panes.slice(0, 2)).toEqual([{ draftId: "draft-1" }, { draftId: "draft-2" }]);
  });

  it("swaps two panes' threads and projects, keeping focus on the moved thread", () => {
    useWorkspacePaneStore.setState({ layoutsByProjectKey: {} });
    const thread = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const actions = useWorkspacePaneStore.getState();
    actions.setPaneCount("window-a", 5);
    actions.setPaneProject("window-a", 0, "project-0");
    actions.setPaneProject("window-a", 3, "project-3");
    actions.assignThread("window-a", thread, 3);
    actions.swapPanes("window-a", 3, 0);

    const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), "window-a");
    expect(layout.panes.slice(0, 5)).toEqual([thread, null, null, null, null]);
    expect(layout.projectKeys.slice(0, 5)).toEqual(["project-3", null, null, "project-0", null]);
    expect(layout.focusedPaneIndex).toBe(0);
  });

  it("packs occupied panes before empty panes when shrinking", () => {
    const firstThread = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));
    const secondThread = scopeThreadRef(
      "environment-1" as EnvironmentId,
      ThreadId.make("thread-2"),
    );
    const thirdThread = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-3"));
    const panes = [...EMPTY_PANES];
    panes[0] = firstThread;
    panes[3] = secondThread;
    panes[5] = thirdThread;
    const projectKeys = Array.from({ length: WORKSPACE_PANE_COUNT }, () => null as string | null);
    projectKeys[0] = "project-1";
    projectKeys[3] = "project-2";
    projectKeys[5] = "project-3";

    const resized = resizeWorkspaceLayoutPaneCount(
      {
        ...DEFAULT_PROJECT_WORKSPACE_LAYOUT,
        panes,
        projectKeys,
        paneCount: 6,
        focusedPaneIndex: 5,
      },
      4,
    );

    expect(resized.panes.slice(0, 4)).toEqual([firstThread, secondThread, thirdThread, null]);
    expect(resized.projectKeys.slice(0, 4)).toEqual(["project-1", "project-2", "project-3", null]);
    expect(resized.focusedPaneIndex).toBe(2);
  });

  it("retains the focused thread and keeps overflow available when shrinking", () => {
    const threads = Array.from({ length: 5 }, (_, index) =>
      scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make(`thread-${index + 1}`)),
    );
    const panes = [...EMPTY_PANES];
    for (const [index, thread] of threads.entries()) {
      panes[index] = thread;
    }

    const shrunk = resizeWorkspaceLayoutPaneCount(
      {
        ...DEFAULT_PROJECT_WORKSPACE_LAYOUT,
        panes,
        paneCount: 6,
        focusedPaneIndex: 4,
      },
      4,
    );

    expect(shrunk.panes.slice(0, 4)).toEqual([threads[0], threads[1], threads[2], threads[4]]);
    expect(shrunk.focusedPaneIndex).toBe(3);
    expect(shrunk.panes[4]).toEqual(threads[3]);

    const expanded = resizeWorkspaceLayoutPaneCount(shrunk, 5);
    expect(expanded.panes.slice(0, 5)).toContain(threads[3]);
  });
});
