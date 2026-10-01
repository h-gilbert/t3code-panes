import {
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";

import { getBrowseLeafPathSegment } from "./lib/projectPaths";

export function resolvePaneEnvironmentMode(input: {
  readonly embeddedPane: boolean;
  readonly requestedMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}) {
  if (input.embeddedPane && !input.branch && !input.worktreePath) return "local";
  return input.requestedMode;
}

// A pane hides the Git controls, so it cannot carry an implicit worktree
// request to another machine without also providing a way to choose its base.
// Explicit project defaults still apply on surfaces with the Git toolbar.
export function getRemoteProjectDraftContext(input: {
  readonly embeddedPane: boolean;
  readonly requestedMode: "local" | "worktree";
}) {
  const envMode = input.embeddedPane ? "local" : input.requestedMode;
  return {
    envMode,
    branch: null,
    worktreePath: null,
    startFromOrigin: envMode === "worktree",
  } as const;
}

export function getAutomaticRemoteProjectDestination(input: {
  readonly baseDirectory: string;
  readonly owner: string | null | undefined;
  readonly remoteUrl: string;
  readonly workspaceRoot: string;
}): string {
  const baseDirectory = input.baseDirectory.trim();
  const owner = input.owner?.trim() ?? "";
  const repositoryDirectory =
    getBrowseLeafPathSegment(input.workspaceRoot) || getCloneDirectoryName(input.remoteUrl);
  const ownerDirectory = owner ? getCloneDestinationPath(baseDirectory, owner) : baseDirectory;
  return getCloneDestinationPath(ownerDirectory, repositoryDirectory);
}
