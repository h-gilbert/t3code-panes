import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { isSidebarSubagentThread, sortThreadsForSidebar } from "./components/Sidebar.logic";
import type { WorkspacePaneTarget } from "./workspacePaneStore";

export interface WorkspaceThreadPickerProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjectRefs: readonly ReturnType<typeof scopeProjectRef>[];
}

export interface WorkspaceThreadPickerItem {
  readonly threadRef: ReturnType<typeof scopeThreadRef>;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly status: "open" | "settled";
  readonly runningSubagentCount: number;
}

export function buildWorkspaceThreadPickerItems(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projects: readonly WorkspaceThreadPickerProject[];
  readonly paneTargets: readonly (WorkspacePaneTarget | null)[];
  readonly settledThreadKeys?: ReadonlySet<string>;
}): WorkspaceThreadPickerItem[] {
  const openThreadKeys = new Set(
    input.paneTargets.flatMap((target) =>
      target && "threadId" in target ? [scopedThreadKey(target)] : [],
    ),
  );
  const projectByRef = new Map(
    input.projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) => [scopedProjectKey(projectRef), project] as const,
      ),
    ),
  );

  const runningCounts = countRunningWorkspaceSubagents(input.threads);
  return sortThreadsForSidebar(
    input.threads.filter((thread) => {
      if (thread.archivedAt !== null || isSidebarSubagentThread(thread)) return false;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      return (
        !openThreadKeys.has(scopedThreadKey(threadRef)) &&
        projectByRef.has(scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)))
      );
    }),
  ).flatMap((thread) => {
    const project = projectByRef.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    if (!project) return [];
    return [
      {
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        title: thread.title,
        runningSubagentCount:
          runningCounts.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ?? 0,
        projectKey: project.projectKey,
        projectName: project.displayName,
        status: input.settledThreadKeys?.has(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        )
          ? "settled"
          : "open",
      },
    ];
  });
}

export function workspaceThreadPickerItemsForProject(
  items: readonly WorkspaceThreadPickerItem[],
  projectKey: string | null,
): readonly WorkspaceThreadPickerItem[] {
  return projectKey === null ? items : items.filter((item) => item.projectKey === projectKey);
}

/** Counts active descendants under each ancestor using environment-scoped shell identities. */
export function countRunningWorkspaceSubagents(
  threads: readonly EnvironmentThreadShell[],
): ReadonlyMap<string, number> {
  const byKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      !isSidebarSubagentThread(thread) ||
      !["preparing", "queued", "starting", "running", "waiting"].includes(
        thread.source?.activityRunStatus ?? thread.source?.status ?? thread.runtime?.status ?? "",
      )
    )
      continue;
    const seen = new Set([scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))]);
    let child: EnvironmentThreadShell | undefined = thread;
    while (child?.lineage.relationshipToParent === "subagent" && child.lineage.parentThreadId) {
      const parentKey = scopedThreadKey(
        scopeThreadRef(thread.environmentId, child.lineage.parentThreadId),
      );
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
      child = byKey.get(parentKey);
    }
  }
  return counts;
}
