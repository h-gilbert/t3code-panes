import { ThreadId, TurnId, RunId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { readRunClientOrigin, readTurnClientOrigin } from "./turnClientOrigin.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(SqlitePersistenceMemory)("persisted turn origin", (it) => {
  it.effect("matches each turn's message, not the thread's first or latest client", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const thread = ThreadId.make("mixed-thread");
      for (const [index, origin] of ["ios", "web", "desktop", null, "ios"].entries()) {
        const messageId = `message-${index}`;
        const payload = yield* encodePayload({
          messageId,
          ...(origin ? { clientOrigin: origin } : {}),
        });
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type,
           occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${index}`}, 'thread', ${thread}, ${index + 1},
            'thread.turn-start-requested', '2026-09-07T00:00:00Z', 'user',
            ${payload}, '{}')`;
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
          VALUES (${thread}, ${`turn-${index}`}, ${messageId}, 'completed',
            '2026-09-07T00:00:00Z', '[]')`;
      }
      for (const [index, origin] of ["ios", "web", "desktop", null, "ios"].entries()) {
        assert.equal(yield* readTurnClientOrigin(thread, TurnId.make(`turn-${index}`)), origin);
      }
      assert.isNull(yield* readTurnClientOrigin(thread, TurnId.make("missing")));
      assert.isNull(
        yield* readTurnClientOrigin(ThreadId.make("another-thread"), TurnId.make("turn-0")),
      );
    }),
  );
});

it.layer(SqlitePersistenceMemory)("persisted V2 run origin", (it) => {
  it.effect("attributes each follow-up to its initiating client after reconnects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("v2-mixed-client-thread");
      const origins = ["ios", "web", "mobile", "ios", "server"];
      for (const [index, creationSource] of origins.entries()) {
        const messageId = `v2-message-${index}`,
          runId = `v2-run-${index}`;
        const message = yield* encodePayload({ creationSource });
        const run = yield* encodePayload({ userMessageId: messageId });
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${messageId}, ${threadId}, 'user', 0, '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z', ${message})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${threadId}, ${index}, 'codex', 'completed', '2026-09-07T00:00:00Z', ${run})`;
      }
      for (const [index, origin] of origins.entries())
        assert.equal(yield* readRunClientOrigin(threadId, RunId.make(`v2-run-${index}`)), origin);
      assert.isNull(yield* readRunClientOrigin(threadId, RunId.make("unknown")));
      assert.isNull(
        yield* readRunClientOrigin(ThreadId.make("another-thread"), RunId.make("v2-run-0")),
      );
    }),
  );
});
