import {
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";

import { getBrowseLeafPathSegment } from "./lib/projectPaths";

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
