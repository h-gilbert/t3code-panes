import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspaceThreadPickerItems,
  countRunningWorkspaceSubagents,
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
    lineage: { parentThreadId: null, relationshipToParent: null },
    runtime: null,
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

describe("subagents in workspace lists", () => {
  const child = (id: string, parent: string, running = true) => ({
    ...thread(id, projectA),
    lineage: {
      ...thread(id, projectA).lineage,
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent" as const,
    },
    runtime: running ? ({ status: "running" } as EnvironmentThreadShell["runtime"]) : null,
  });

  it("shows parents and user forks, hides delegated and native children, and counts nested work", () => {
    const fork = {
      ...thread("fork", projectA),
      lineage: {
        ...thread("fork", projectA).lineage,
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "fork" as const,
      },
    };
    const threads = [
      thread("parent", projectA),
      child("agent", "parent"),
      child("nested", "agent"),
      child("done", "parent", false),
      fork,
    ];
    const items = buildWorkspaceThreadPickerItems({ threads, projects, paneTargets: [] });
    expect(
      items.map(({ title, runningSubagentCount }) => ({ title, runningSubagentCount })),
    ).toEqual([
      { title: "Thread fork", runningSubagentCount: 0 },
      { title: "Thread parent", runningSubagentCount: 2 },
    ]);
  });

  it("keeps counts environment-scoped and ignores archived work and lineage cycles", () => {
    const remote = {
      ...child("remote-agent", "parent"),
      environmentId: EnvironmentId.make("remote"),
    };
    const archived = { ...child("archived", "parent"), archivedAt: "2026-09-02T00:00:00.000Z" };
    const counts = countRunningWorkspaceSubagents([
      thread("parent", projectA),
      remote,
      archived,
      child("cycle", "cycle"),
    ]);
    expect(counts.get("local:parent") ?? 0).toBe(0);
    expect(counts.get("remote:parent")).toBe(1);
    expect(counts.has("local:cycle")).toBe(false);
  });

  it("counts V2 native child activity without an app-owned run", () => {
    const native = {
      ...child("native", "parent", false),
      source: { status: "running", activityRunStatus: null } as EnvironmentThreadShell["source"],
    };
    const counts = countRunningWorkspaceSubagents([thread("parent", projectA), native]);
    expect(counts.get("local:parent")).toBe(1);
    const completed = {
      ...native,
      source: { ...native.source, status: "completed" },
    } as EnvironmentThreadShell;
    expect(countRunningWorkspaceSubagents([completed]).size).toBe(0);
  });
});
