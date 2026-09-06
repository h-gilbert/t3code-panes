import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Resolve the exact turn's persisted start request, including after a restart.
// A thread can alternate between phone and desktop submissions.
export const readTurnClientOrigin = Effect.fn("Notifications.readTurnClientOrigin")(function* (
  threadId: ThreadId,
  turnId: TurnId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly origin: string | null }>`
    SELECT json_extract(event.payload_json, '$.clientOrigin') AS origin
    FROM projection_turns AS turn
    JOIN orchestration_events AS event
      ON event.aggregate_kind = 'thread'
      AND event.stream_id = turn.thread_id
      AND event.event_type = 'thread.turn-start-requested'
      AND json_extract(event.payload_json, '$.messageId') = turn.pending_message_id
    WHERE turn.thread_id = ${threadId} AND turn.turn_id = ${turnId}
    ORDER BY event.sequence DESC
    LIMIT 1
  `;
  return rows[0]?.origin ?? null;
});
