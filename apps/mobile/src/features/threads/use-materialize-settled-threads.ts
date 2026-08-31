import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Turns client-derived auto-settlement into the same durable command used by
 * manual settlement. The server event is the resource-cleanup boundary.
 */
export function useMaterializeSettledThreads(threads: ReadonlyArray<EnvironmentThreadShell>): void {
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const inFlightKeys = useRef(new Set<string>());

  useEffect(() => {
    for (const thread of threads) {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightKeys.current.has(key)) continue;
      inFlightKeys.current.add(key);
      void settle({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      }).finally(() => inFlightKeys.current.delete(key));
    }
  }, [settle, threads]);
}
