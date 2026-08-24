type WorkspaceThreadActivity = {
  readonly session: { readonly status: string } | null;
  readonly backgroundLiveness?: unknown | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
};

export function workspaceThreadNeedsFinishConfirmation(
  thread: WorkspaceThreadActivity | null,
): boolean {
  if (!thread) return false;

  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  );
}
