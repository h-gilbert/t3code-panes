import type { ThreadId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Follow-ups carry their own source; the thread's first message cannot decide completion alerts.
export const readRunClientOrigin = Effect.fn("Notifications.readRunClientOrigin")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly origin: string | null }>`
    SELECT json_extract(message.payload_json, '$.creationSource') AS origin
    FROM orchestration_v2_projection_runs AS run
    JOIN orchestration_v2_projection_messages AS message
      ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      AND message.thread_id = run.thread_id
    WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
    LIMIT 1
  `;
  return rows[0]?.origin ?? null;
});
