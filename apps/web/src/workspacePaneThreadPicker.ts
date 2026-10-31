import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

import {
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
  sortThreadsForSidebar,
} from "./components/Sidebar.logic";
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
  readonly paneIndex: number | null;
  readonly environmentLabel: string;
  readonly updatedAt: string;
  readonly activity: ReturnType<typeof resolveSidebarThreadStatus>;
}

export type WorkspaceRunningSubagent = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "title" | "providerInstanceId"
>;

export function mergeWorkspaceRunningSubagents(
  threads: readonly EnvironmentThreadShell[],
  tasks: readonly OrchestrationV2Subagent[],
  knownThreads: readonly EnvironmentThreadShell[] = threads,
): readonly WorkspaceRunningSubagent[] {
  const known = new Map(
    knownThreads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const agents = new Map<string, WorkspaceRunningSubagent>(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      {
        ...thread,
        providerInstanceId: thread.runtime?.providerInstanceId ?? thread.providerInstanceId,
      },
    ]),
  );
  for (const task of tasks) {
    if (task.remoteChild === undefined || (task.status !== "running" && task.status !== "waiting"))
      continue;
    const ref = task.remoteChild;
    const key = scopedThreadKey(ref);
    if (agents.has(key)) continue;
    const shell = known.get(key);
    if (shell !== undefined && (ref.runId === undefined || shell.latestRun?.runId === ref.runId))
      continue;
    agents.set(key, {
      environmentId: ref.environmentId,
      id: ref.threadId,
      title: task.title ?? "Subagent",
      providerInstanceId: task.providerInstanceId,
    });
  }
  return [...agents.values()];
}

export function buildWorkspaceThreadPickerItems(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projects: readonly WorkspaceThreadPickerProject[];
  readonly paneTargets: readonly (WorkspacePaneTarget | null)[];
  readonly settledThreadKeys?: ReadonlySet<string>;
  readonly environmentLabels?: ReadonlyMap<string, string>;
}): WorkspaceThreadPickerItem[] {
  const paneByThread = new Map<string, number>();
  input.paneTargets.forEach((target, index) => {
    if (target && "threadId" in target && !paneByThread.has(scopedThreadKey(target))) {
      paneByThread.set(scopedThreadKey(target), index);
    }
  });
  const projectByRef = new Map(
    input.projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) => [scopedProjectKey(projectRef), project] as const,
      ),
    ),
  );

  const runningCounts = countRunningWorkspaceSubagents(input.threads);
  const threadKeys = new Set(
    input.threads
      .filter((thread) => thread.archivedAt === null && thread.deletedAt == null)
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return sortThreadsForSidebar(
    input.threads.filter((thread) => {
      if (thread.archivedAt !== null || thread.deletedAt != null || isSidebarSubagentThread(thread))
        return false;
      if (thread.delegatedFrom != null && threadKeys.has(scopedThreadKey(thread.delegatedFrom)))
        return false;
      return projectByRef.has(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
    }),
  ).flatMap((thread) => {
    const project = projectByRef.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    if (!project) return [];
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const paneIndex = paneByThread.get(threadKey) ?? null;
    const status = input.settledThreadKeys?.has(threadKey) ? "settled" : "open";
    if (status === "open" && paneIndex !== null) return [];
    return [
      {
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        title: thread.title,
        paneIndex,
        environmentLabel:
          input.environmentLabels?.get(thread.environmentId) ?? thread.environmentId,
        updatedAt: thread.updatedAt ?? thread.createdAt,
        activity: resolveSidebarThreadStatus(thread),
        runningSubagentCount:
          runningCounts.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ?? 0,
        projectKey: project.projectKey,
        projectName: project.displayName,
        status,
      },
    ];
  });
}

export function filterWorkspaceThreadPickerItems(
  items: readonly WorkspaceThreadPickerItem[],
  filter: {
    readonly projectKey: string | null;
    readonly status: "all" | "open" | "settled";
    readonly query: string;
  },
) {
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.projectKey !== null && item.projectKey !== filter.projectKey) return false;
    if (filter.status !== "all" && item.status !== filter.status) return false;
    const text = `${item.title} ${item.projectName} ${item.environmentLabel}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Counts active descendants under each ancestor using environment-scoped shell identities. */
export function countRunningWorkspaceSubagents(
  threads: readonly EnvironmentThreadShell[],
): ReadonlyMap<string, number> {
  return new Map(
    Array.from(runningWorkspaceSubagentsByParent(threads), ([key, agents]) => [key, agents.length]),
  );
}

/** Running descendants shown by each pane's agent picker, including nested agents. */
export function runningWorkspaceSubagentsByParent(
  threads: readonly EnvironmentThreadShell[],
): ReadonlyMap<string, readonly EnvironmentThreadShell[]> {
  const byKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const agentsByParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      (!isSidebarSubagentThread(thread) && thread.delegatedFrom == null) ||
      !["preparing", "queued", "starting", "running", "waiting"].includes(
        thread.source?.activityRunStatus ?? thread.source?.status ?? thread.runtime?.status ?? "",
      )
    )
      continue;
    const seen = new Set([scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))]);
    let child: EnvironmentThreadShell | undefined = thread;
    while (child !== undefined) {
      const parent =
        child.lineage.relationshipToParent === "subagent" && child.lineage.parentThreadId
          ? scopeThreadRef(child.environmentId, child.lineage.parentThreadId)
          : child.delegatedFrom;
      if (parent == null) break;
      const parentKey = scopedThreadKey(parent);
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      const agents = agentsByParent.get(parentKey);
      if (agents) agents.push(thread);
      else agentsByParent.set(parentKey, [thread]);
      child = byKey.get(parentKey);
    }
  }
  return agentsByParent;
}
