import { DEFAULT_WORKSPACE_KEY, isWorkspacePath } from "./workspacePaneStore";

export function resolveRetainedWorkspaceKey(input: {
  readonly pathname: string;
  readonly workspaceSearch: unknown;
  readonly previousWorkspaceKey: string | null;
}): string | null {
  if (isWorkspacePath(input.pathname)) {
    return typeof input.workspaceSearch === "string"
      ? input.workspaceSearch
      : DEFAULT_WORKSPACE_KEY;
  }

  if (input.pathname === "/settings" || input.pathname.startsWith("/settings/")) {
    return input.previousWorkspaceKey;
  }

  return null;
}
