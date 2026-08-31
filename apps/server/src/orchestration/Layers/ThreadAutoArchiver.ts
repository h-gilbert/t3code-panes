import { CommandId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

export const DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export interface ThreadAutoArchiverLiveOptions {
  readonly archiveAfterMs?: number;
  readonly sweepIntervalMs?: number;
}

export function isThreadEligibleForAutoArchive(
  thread: Pick<OrchestrationThreadShell, "archivedAt" | "settledAt" | "settledOverride">,
  input: { readonly nowMs: number; readonly archiveAfterMs: number },
): thread is typeof thread & { readonly settledAt: string } {
  if (
    thread.archivedAt !== null ||
    thread.settledOverride !== "settled" ||
    thread.settledAt === null
  ) {
    return false;
  }
  const settledAtMs = Date.parse(thread.settledAt);
  return Number.isFinite(settledAtMs) && input.nowMs - settledAtMs >= input.archiveAfterMs;
}

const makeThreadAutoArchiver = (options?: ThreadAutoArchiverLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const archiveAfterMs = Math.max(
      1,
      options?.archiveAfterMs ?? DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.fn("ThreadAutoArchiver.sweep")(function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const nowMs = yield* Clock.currentTimeMillis;
      let archivedCount = 0;

      for (const thread of snapshot.threads) {
        if (!isThreadEligibleForAutoArchive(thread, { nowMs, archiveAfterMs })) continue;
        const settledAt = thread.settledAt;
        const commandId = CommandId.make(`server:auto-archive:${thread.id}:${settledAt}`);
        const archived = yield* orchestrationEngine
          .dispatch({
            type: "thread.archive",
            commandId,
            threadId: thread.id,
            ifSettledAt: settledAt,
          })
          .pipe(
            Effect.as(true),
            // Activity can un-settle the thread after the snapshot. The
            // decider rejects that stale command through ifSettledAt.
            Effect.catchCause((cause) =>
              Effect.logDebug("thread auto-archive skipped", {
                threadId: thread.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
        if (archived) archivedCount += 1;
      }

      if (archivedCount > 0) {
        yield* Effect.logInfo("thread auto-archive sweep complete", { archivedCount });
      }
    });

    yield* forkParked(
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread auto-archive sweep failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
      ),
    );
    yield* Effect.logInfo("thread auto-archiver started", { archiveAfterMs, sweepIntervalMs });
  });

export const makeThreadAutoArchiverLive = (options?: ThreadAutoArchiverLiveOptions) =>
  Layer.effectDiscard(makeThreadAutoArchiver(options));

export const ThreadAutoArchiverLive = makeThreadAutoArchiverLive();
