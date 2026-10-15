import { parseThreadKey, threadKey as scopedRefKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import { AsyncResult, Atom } from "effect/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import type { PendingThreadCreationOutcome } from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

/** All detail readers, including composer metadata, must wait for creation. */
export function createThreadCreationGatedStateAtoms<E>(input: {
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  readonly queuedMessagesAtom: Atom.Atom<
    Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>
  >;
  readonly outcomesAtom: Atom.Atom<Readonly<Record<string, PendingThreadCreationOutcome>>>;
  readonly shellAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<Pick<EnvironmentThreadShell, "id"> | null>;
}) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
    let awaitingCreation = false;
    return Atom.make((get) => {
      const creation = get(input.queuedMessagesAtom)[threadKey]?.some(
        (message) => message.creation !== undefined,
      );
      const outcome = get(input.outcomesAtom)[threadKey];
      // Failed delivery removes the queue entry before publishing its outcome.
      // Keep waiting across that gap and enqueue rollbacks until creation is confirmed.
      if (creation || outcome?.kind === "failed") awaitingCreation = true;
      if (awaitingCreation) {
        if (outcome?.kind === "delivered" || get(input.shellAtom(ref)) !== null) {
          awaitingCreation = false;
        } else {
          return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
        }
      }
      return get(input.stateAtom(ref.environmentId, ref.threadId));
    });
  });
  return {
    stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      family(scopedRefKey({ environmentId, threadId })),
  };
}
