import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  DEFAULT_PROJECT_WORKSPACE_LAYOUT,
  WORKSPACE_PANE_COUNT,
  assignWorkspaceThread,
  isWorkspacePath,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
  type WorkspacePanes,
} from "./workspacePaneStore";

const EMPTY_PANES = Array.from(
  { length: WORKSPACE_PANE_COUNT },
  () => null,
) as unknown as WorkspacePanes;

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
});
