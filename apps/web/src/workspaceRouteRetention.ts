import { DEFAULT_WORKSPACE_KEY, isWorkspacePath } from "./workspacePaneStore";

export function resolveRetainedWorkspaceKey(input: {
  readonly pathname: string;
  readonly workspaceSearch: unknown;
  readonly previousWorkspaceKey: string | null;
}): string | null {
  if (typeof input.workspaceSearch === "string") return input.workspaceSearch;
  if (isWorkspacePath(input.pathname)) {
    return DEFAULT_WORKSPACE_KEY;
  }

  return input.previousWorkspaceKey ?? DEFAULT_WORKSPACE_KEY;
}
