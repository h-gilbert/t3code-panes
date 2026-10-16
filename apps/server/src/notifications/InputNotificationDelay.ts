import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

export const INPUT_NOTIFICATION_DELAY_MS = 90_000;

export function isDue(
  current: Pick<OrchestrationV2ThreadShell, "archivedAt" | "pendingRuntimeRequest"> | null,
  requestId: string,
  nowMs: number,
) {
  return (
    current !== null &&
    current.archivedAt === null &&
    current.pendingRuntimeRequest?.kind === "user_input" &&
    current.pendingRuntimeRequest.id === requestId &&
    current.pendingRuntimeRequest.createdAt.epochMilliseconds + INPUT_NOTIFICATION_DELAY_MS <= nowMs
  );
}

/** One wake per question. Other events in the same thread must not restart its clock. */
export const make = Effect.fnUntraced(function* (
  wake: (threadId: ThreadId, requestId: string) => Effect.Effect<void>,
) {
  const scope = yield* Scope.Scope;
  const pending = new Map<ThreadId, { requestId: string; fiber: Fiber.Fiber<void> }>();
  return {
    update: Effect.fnUntraced(function* (
      threadId: ThreadId,
      request: { readonly id: string; readonly createdAt: DateTime.Utc } | null,
    ) {
      const previous = pending.get(threadId);
      if (previous?.requestId === request?.id) return;
      pending.delete(threadId);
      if (previous) yield* Fiber.interrupt(previous.fiber);
      if (!request) return;
      const now = yield* DateTime.now;
      const remaining = Math.max(
        0,
        request.createdAt.epochMilliseconds + INPUT_NOTIFICATION_DELAY_MS - now.epochMilliseconds,
      );
      const fiber = yield* Effect.sleep(remaining).pipe(
        Effect.andThen(wake(threadId, request.id)),
        Effect.forkIn(scope),
      );
      // Retain the ID after waking so repeated status updates cannot send it again.
      pending.set(threadId, { requestId: request.id, fiber });
    }),
  };
});
