import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { readRunClientOrigin } from "./turnClientOrigin.ts";

import { makeEnvironmentAggregate, notificationForTransition } from "./SelfHostedNotifications.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(SqlitePersistenceMemory)("persisted V2 run origin", (it) => {
  it.effect("attributes each follow-up to its initiating client after reconnects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("v2-mixed-client-thread");
      // Desktop uses the same "web" creation source as the browser client.
      // Include old messages without an origin and later follow-ups from both clients.
      const origins = ["ios", "web", "mobile", null, "ios", "server", "web"];
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_turns'`,
        [],
      );
      for (const [index, creationSource] of origins.entries()) {
        const messageId = `v2-message-${index}`,
          runId = `v2-run-${index}`;
        const message = yield* encodePayload(creationSource === null ? {} : { creationSource });
        const run = yield* encodePayload({ userMessageId: messageId });
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${messageId}, ${threadId}, 'user', 0, '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z', ${message})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${threadId}, ${index}, 'codex', 'completed', '2026-09-07T00:00:00Z', ${run})`;
      }
      // Resolve after every submission is persisted, as on a reconnect or restart.
      for (const [index, origin] of origins.entries()) {
        const persistedOrigin = yield* readRunClientOrigin(threadId, RunId.make(`v2-run-${index}`));
        assert.equal(persistedOrigin, origin);
        const state = {
          environmentId: EnvironmentId.make("environment"),
          threadId,
          projectTitle: "T3 Code",
          threadTitle: "Mixed-client follow-ups",
          headline: "Working",
          modelTitle: "Codex",
          updatedAt: "2026-09-07T00:00:00Z",
          deepLink: "/environment/thread",
        };
        const nowMs = Date.parse(state.updatedAt);
        const notification = notificationForTransition({
          previous: makeEnvironmentAggregate([{ ...state, phase: "running" }], nowMs),
          next: makeEnvironmentAggregate([{ ...state, phase: "completed" }], nowMs),
          iosCompletionThreads: new Set(persistedOrigin === "ios" ? [threadId] : []),
          nowMs,
          registration: {
            device: {
              deviceId: "phone",
              label: "iPhone",
              platform: "ios",
              iosMajorVersion: 18,
              preferences: {
                notificationsEnabled: true,
                liveActivitiesEnabled: false,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnFailure: true,
                notifyOnCompletion: true,
                notifyOnIosCompletion: true,
              },
            },
            activityPushToken: null,
            lastAggregate: null,
            lastDeliveryAt: null,
          },
        });
        assert.equal(notification?.row.phase ?? null, origin === "ios" ? "completed" : null);
      }
      const orphanRun = yield* encodePayload({ userMessageId: "v2-message-0" });
      const anotherThread = ThreadId.make("another-thread");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('cross-thread-run', ${anotherThread}, 0, 'codex', 'completed', '2026-09-07T00:00:00Z', ${orphanRun})`;
      assert.isNull(yield* readRunClientOrigin(anotherThread, RunId.make("cross-thread-run")));
      assert.isNull(yield* readRunClientOrigin(threadId, RunId.make("unknown")));
      assert.isNull(
        yield* readRunClientOrigin(ThreadId.make("another-thread"), RunId.make("v2-run-0")),
      );
    }),
  );
});
