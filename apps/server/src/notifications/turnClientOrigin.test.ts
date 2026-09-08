import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readTurnClientOrigin } from "./turnClientOrigin.ts";

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
