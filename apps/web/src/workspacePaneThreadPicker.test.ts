import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspaceThreadPickerItems,
  type WorkspaceThreadPickerProject,
  workspaceThreadPickerItemsForProject,
} from "./workspacePaneThreadPicker";

const environmentId = EnvironmentId.make("local");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

function thread(
  id: string,
  projectId: ProjectId,
  options: { readonly archived?: boolean; readonly createdAt?: string } = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    environmentId,
    title: `Thread ${id}`,
    createdAt: options.createdAt ?? "2026-09-01T00:00:00.000Z",
    archivedAt: options.archived ? "2026-09-02T00:00:00.000Z" : null,
  } as EnvironmentThreadShell;
}

const projects = [
  {
    projectKey: "group-a",
    displayName: "Project A",
    memberProjectRefs: [{ environmentId, projectId: projectA }],
  },
  {
    projectKey: "group-b",
    displayName: "Project B",
    memberProjectRefs: [{ environmentId, projectId: projectB }],
  },
] satisfies WorkspaceThreadPickerProject[];

describe("workspace pane thread picker", () => {
  it("lists non-archived threads that are not assigned to another pane", () => {
    const items = buildWorkspaceThreadPickerItems({
      threads: [
        thread("available", projectA, { createdAt: "2026-09-03T00:00:00.000Z" }),
        thread("already-open", projectA),
        thread("archived", projectB, { archived: true }),
      ],
      projects,
      paneTargets: [scopeThreadRef(environmentId, ThreadId.make("already-open"))],
    });

    expect(items.map((item) => item.threadRef.threadId)).toEqual([ThreadId.make("available")]);
  });

  it("scopes the list to a selected project and shows every project without one", () => {
    const items = buildWorkspaceThreadPickerItems({
      threads: [thread("a", projectA), thread("b", projectB)],
      projects,
      paneTargets: [],
    });

    expect(
      workspaceThreadPickerItemsForProject(items, "group-a").map((item) => item.title),
    ).toEqual(["Thread a"]);
    expect(workspaceThreadPickerItemsForProject(items, null).map((item) => item.title)).toEqual([
      "Thread a",
      "Thread b",
    ]);
  });

  it("marks settled threads without removing them from the picker", () => {
    const items = buildWorkspaceThreadPickerItems({
      threads: [thread("open", projectA), thread("settled", projectA)],
      projects,
      paneTargets: [],
      settledThreadKeys: new Set([`${environmentId}:settled`]),
    });

    expect(items.map(({ title, status }) => ({ title, status }))).toEqual([
      { title: "Thread open", status: "open" },
      { title: "Thread settled", status: "settled" },
    ]);
  });
});
