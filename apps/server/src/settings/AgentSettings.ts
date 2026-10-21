import {
  CommandId,
  OrchestratorMcpFailure,
  RuntimeRequestId,
  type RunId,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";

/** Settings changes proposed by an agent always need a fresh app-owned approval. */
export class AgentSettings extends Context.Service<
  AgentSettings,
  {
    readonly update: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly reason: string;
      readonly patch: ServerSettingsPatch;
    }) => Effect.Effect<{ readonly applied: boolean }, OrchestratorMcpFailure>;
  }
>()("t3/settings/AgentSettings") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The settings change could not be completed.",
  });

const encodePatch = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* Settings.ServerSettingsService;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const environment = yield* Environment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  return AgentSettings.of({
    update: Effect.fn("AgentSettings.update")(function* (input) {
      if (Object.keys(input.patch).length === 0 || input.reason.trim().length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Provide settings changes and explain why they are needed.",
        });
      }
      const descriptor = yield* environment.getDescriptor;
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const requestId = RuntimeRequestId.make(`settings:${id}`);
      const afterSequence = yield* threads
        .getThreadEventSequence(input.threadId)
        .pipe(Effect.mapError(unavailable));
      yield* threads
        .dispatch({
          type: "settings-change.request",
          commandId: CommandId.make(`settings:request:${id}`),
          threadId: input.threadId,
          runId: input.runId,
          requestId,
          prompt: `Change T3 Code settings on ${descriptor.label} (${descriptor.environmentId})?\n\n${input.reason}\n\nProposed changes:\n${encodePatch(input.patch)}\n\nApplies to this environment. Omitted settings are preserved. Access changes may require a new turn.`,
        })
        .pipe(Effect.mapError(unavailable));

      const close = threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`settings:cancel:${id}`),
          threadId: input.threadId,
          requestId,
          decision: "cancel",
        })
        .pipe(Effect.ignore);
      return yield* Effect.gen(function* () {
        const answer = yield* threads
          .streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType: "runtime-request.updated",
          })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) =>
                event.type === "runtime-request.updated" &&
                event.payload.id === requestId &&
                event.payload.status !== "pending",
            ),
            Stream.runHead,
            Effect.mapError(unavailable),
          );
        if (
          Option.isNone(answer) ||
          answer.value.type !== "runtime-request.updated" ||
          answer.value.payload.status !== "resolved" ||
          answer.value.payload.decision !== "accept"
        ) {
          return { applied: false };
        }
        return yield* executor.withLock(
          input.threadId,
          Effect.gen(function* () {
            // A response may race a Stop or a subsequent turn. Approval belongs only to this run.
            const shell = yield* threads
              .getThreadShell(input.threadId)
              .pipe(Effect.mapError(unavailable));
            if (
              !shell ||
              shell.activeRunId !== input.runId ||
              shell.archivedAt !== null ||
              shell.deletedAt !== null
            ) {
              return yield* new OrchestratorMcpFailure({
                code: "parent_not_active",
                message: "The run requesting this settings change has ended.",
              });
            }
            yield* settings.updateSettings(input.patch).pipe(Effect.mapError(unavailable));
            return { applied: true };
          }),
        );
      }).pipe(Effect.ensuring(close));
    }),
  });
});

export const layer = Layer.effect(AgentSettings, make);
