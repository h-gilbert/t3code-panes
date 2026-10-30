import type { ConnectionDiagnosticEvent } from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

const RecordSchema = Schema.Struct({
  timestamp: Schema.String,
  kind: Schema.String,
  environmentId: Schema.NullOr(Schema.String),
  fields: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
});
export type ConnectionLogRecord = typeof RecordSchema.Type;
const decodeRecords = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RecordSchema)));
export const CONNECTION_LOG_LIMIT = 300;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function redactConnectionDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(
      /\b(token|credential|authorization|password|secret|code)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 2000);
}

export function connectionLogRecord(
  event: ConnectionDiagnosticEvent,
  timestamp: string,
): ConnectionLogRecord {
  const { state } = event;
  const failure = event.failure ?? state.lastFailure;
  return {
    timestamp,
    kind: event.kind,
    environmentId: event.environmentId,
    fields: {
      label: event.label,
      phase: state.phase,
      stage: state.stage,
      desired: state.desired,
      network: state.network,
      attempt: state.attempt,
      generation: state.generation,
      nextRetry: state.retryAt === null ? null : new Date(state.retryAt).toISOString(),
      routes: event.routes.map(redactConnectionDetail).join(", "),
      signal: event.signal ?? null,
      error: failure ? redactConnectionDetail(failure.detail) : null,
      reason: failure?.reason ?? null,
      cause: failure?.failureCause ?? null,
      hop: failure?.hop ?? null,
      via: failure?.via ?? null,
      httpStatus: failure?.httpStatus ?? null,
      traceId: failure?.traceId ?? null,
    },
  };
}

export function makeConnectionLog(storage: {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
}) {
  let records: ReadonlyArray<ConnectionLogRecord> | undefined;
  let pending = Promise.resolve();
  const load = async () => {
    if (records !== undefined) return records;
    const raw = await storage.read();
    try {
      records = raw === null ? [] : decodeRecords(raw).slice(-CONNECTION_LOG_LIMIT);
    } catch {
      records = [];
    }
    return records;
  };
  return {
    append(record: ConnectionLogRecord) {
      const write = pending
        .catch(() => undefined)
        .then(async () => {
          const existing = await load();
          const cutoff = Date.parse(record.timestamp) - RETENTION_MS;
          records = [
            ...existing.filter((value) => Date.parse(value.timestamp) >= cutoff),
            record,
          ].slice(-CONNECTION_LOG_LIMIT);
          await storage.write(JSON.stringify(records));
        });
      pending = write;
      return write;
    },
    async read(environmentId?: string) {
      await pending;
      const current = await load();
      return environmentId === undefined
        ? current
        : current.filter(
            (record) => record.environmentId === null || record.environmentId === environmentId,
          );
    },
  };
}

export function formatConnectionLog(
  records: ReadonlyArray<ConnectionLogRecord>,
  identity: {
    readonly version: string;
    readonly build: string;
  },
): string {
  return [
    `T3 Code connection history · ${identity.version} build ${identity.build}`,
    "Times are UTC. Network state describes the phone's internet connection, not Tailscale tunnel health.",
    ...(records.length === 0
      ? ["No connection events recorded."]
      : records.map(
          (record) =>
            `${record.timestamp} ${record.kind} ${JSON.stringify({ environmentId: record.environmentId, ...record.fields })}`,
        )),
  ].join("\n");
}
