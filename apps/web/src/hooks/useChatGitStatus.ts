import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useAtomCommand } from "../state/use-atom-command";
import { chatGitStatusAtom, NO_CHAT_GIT_STATUS_ATOM, vcsEnvironment } from "../state/vcs";
import { useStableCallback } from "./useStableCallback";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

export function useChatGitStatus(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly threadKey: string | null;
  readonly mutationId: string | null;
}) {
  const { cwd, environmentId, mutationId, threadKey } = input;
  const statusAtom = cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } });
  const data = useAtomValue(statusAtom ? chatGitStatusAtom(statusAtom) : NO_CHAT_GIT_STATUS_ATOM);
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const refresh = useStableCallback(() => {
    if (cwd !== null) void refreshStatus({ environmentId, input: { cwd, localOnly: true } });
  });
  useWorkspaceMutationRefresh({
    enabled: cwd !== null,
    mutationId,
    refresh,
    resourceKey: JSON.stringify([environmentId, cwd, threadKey]),
  });
  return data;
}
