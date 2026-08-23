import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

interface ThreadTitleSource {
  readonly title: string;
}

interface WorkspaceDraftThreadIdentity {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly promotedTo?: ScopedThreadRef | null;
}

export function resolveWorkspacePaneThreadTitle(
  detail: ThreadTitleSource | null,
  shell: ThreadTitleSource | null,
): string | null {
  return shell?.title ?? detail?.title ?? null;
}

/** Resolve a draft's materialized server thread as soon as it appears in the shell index. */
export function resolveWorkspaceDraftThreadRef(
  draft: WorkspaceDraftThreadIdentity | null,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  if (!draft) return null;
  if (draft.promotedTo) return draft.promotedTo;

  return (
    threadRefs.find(
      (ref) => ref.environmentId === draft.environmentId && ref.threadId === draft.threadId,
    ) ?? null
  );
}
