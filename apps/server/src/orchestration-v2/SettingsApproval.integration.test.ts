import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect.each(["accept", "decline", "acceptAlways"] as const)(
  "persists app-owned settings approval and handles %s without a provider callback",
  (decision) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("settings-thread");
      const runId = RunId.make("settings-run");
      const rootNodeId = NodeId.make("settings-root");
      const requestId = RuntimeRequestId.make("settings-request");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "test" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("settings-project"),
        title: "Settings",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("running"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("user"),
              rootNodeId,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const requested = yield* orchestrator.dispatch({
        type: "settings-change.request",
        commandId: CommandId.make("request"),
        threadId,
        runId,
        requestId,
        prompt: "Enable device access on Fred for mobile testing?",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect((yield* orchestrator.getThreadShell(threadId))?.pendingRuntimeRequest).toMatchObject({
        id: requestId,
        kind: "permission",
      });
      const approval = projection.turnItems.find((item) => item.type === "approval_request");
      expect(approval).toMatchObject({
        requestId,
        prompt: "Enable device access on Fred for mobile testing?",
        options: [
          { decision: "accept", label: "Approve change" },
          { decision: "decline", label: "Decline" },
        ],
      });
      expect(
        requested.storedEvents.some(({ event }) => event.type === "runtime-request.updated"),
      ).toBe(true);
      const response = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("respond"),
          threadId,
          requestId,
          decision,
        })
        .pipe(Effect.result);
      const after = yield* orchestrator.getThreadProjection(threadId);
      if (decision === "acceptAlways") {
        expect(response._tag).toBe("Failure");
        expect(after.runtimeRequests[0]?.status).toBe("pending");
      } else {
        expect(response._tag).toBe("Success");
        expect(after.runtimeRequests[0]).toMatchObject({ status: "resolved", decision });
        expect(after.turnItems.find((item) => item.type === "approval_request")?.status).toBe(
          decision === "accept" ? "completed" : "cancelled",
        );
        // Resolving the approval completes only its own node, never the run's root.
        expect(after.runs[0]?.status).toBe("running");
      }
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "settings-approval" },
          ProviderAdapterRegistry.layerFromAdapters([]),
          { runEffectWorker: false },
        ),
      ),
    ),
);
