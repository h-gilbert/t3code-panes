import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Environment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as AgentSettings from "./AgentSettings.ts";

const threadId = ThreadId.make("settings-test");
const runId = RunId.make("run:mcp-test");
const now = DateTime.makeUnsafe("2026-10-16T00:00:00Z");

it.effect.each(["accept", "decline", "cancel", "stopped", "replaced", "interrupted"] as const)(
  "settings approval: %s",
  (outcome) =>
    Effect.gen(function* () {
      const requested =
        yield* Deferred.make<
          Extract<OrchestrationV2InternalCommand, { type: "settings-change.request" }>
        >();
      const watching = yield* Deferred.make<void>();
      const queue = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let shell = liveThreadShell(threadId);
      const patches: unknown[] = [];
      const cancellations: string[] = [];
      const layer = AgentSettings.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            ThreadCommandExecutor.layer,
            Layer.mock(Environment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId: EnvironmentId.make("fred"),
                label: "Fred",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "1",
                capabilities: { repositoryIdentity: false },
              }),
            }),
            Layer.mock(Settings.ServerSettingsService)({
              updateSettings: (patch) =>
                Effect.sync(() => {
                  patches.push(patch);
                  return DEFAULT_SERVER_SETTINGS;
                }),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadEventSequence: () => Effect.succeed(0),
              getThreadShell: () => Effect.sync(() => shell),
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (command.type === "settings-change.request")
                    yield* Deferred.succeed(requested, command);
                  if (command.type === "runtime-request.respond")
                    cancellations.push(command.requestId);
                  return { sequence: 1, storedEvents: [] };
                }),
              streamStoredEventsFrom: () =>
                Stream.unwrap(
                  Deferred.succeed(watching, undefined).pipe(
                    Effect.as(
                      Stream.fromQueue(queue).pipe(
                        Stream.map((event) => ({ sequence: 2, commandId: null, event })),
                      ),
                    ),
                  ),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* AgentSettings.AgentSettings;
        const fiber = yield* service
          .update({
            threadId,
            runId,
            reason: "Test the connected phone",
            patch: { enableAgentDeviceAccess: true },
          })
          .pipe(Effect.forkChild);
        const request = yield* Deferred.await(requested);
        expect(request.prompt).toContain("Fred (fred)");
        expect(request.prompt).toContain("Test the connected phone");
        expect(request.prompt).toContain('"enableAgentDeviceAccess": true');
        expect(patches).toEqual([]);
        yield* Deferred.await(watching);
        if (outcome === "interrupted") {
          yield* Fiber.interrupt(fiber);
          expect(cancellations).toEqual([request.requestId]);
          expect(patches).toEqual([]);
          return;
        }
        if (outcome === "stopped") shell = { ...shell, activeRunId: null };
        if (outcome === "replaced") shell = { ...shell, activeRunId: RunId.make("another-run") };
        yield* Queue.offer(queue, {
          id: EventId.make("answer"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: request.requestId,
            nodeId: NodeId.make("approval"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "permission",
            status: "resolved",
            responseCapability: { type: "settings" },
            createdAt: now,
            resolvedAt: now,
            decision: outcome === "stopped" || outcome === "replaced" ? "accept" : outcome,
          },
        });
        const result = yield* Fiber.join(fiber).pipe(Effect.result);
        if (outcome === "stopped" || outcome === "replaced")
          expect(result).toMatchObject({ _tag: "Failure", failure: { code: "parent_not_active" } });
        else
          expect(result).toMatchObject({
            _tag: "Success",
            success: { applied: outcome === "accept" },
          });
        expect(patches).toEqual(outcome === "accept" ? [{ enableAgentDeviceAccess: true }] : []);
      }).pipe(Effect.provide(layer));
    }),
);
