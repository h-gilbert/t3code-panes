import { describe, expect, it } from "vite-plus/test";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";

import {
  CONNECTION_LOG_LIMIT,
  connectionLogRecord,
  formatConnectionLog,
  makeConnectionLog,
  redactConnectionDetail,
} from "./connection-log";

const event = (timestamp = "2026-10-29T05:00:00.000Z") =>
  connectionLogRecord(
    {
      environmentId: "fred",
      label: "fred-server",
      kind: "failure",
      routes: ["https://user:password@fred.example:8449/private?token=private-token"],
      failure: new ConnectionTransientError({
        reason: "transport",
        detail: "Fred stopped responding for 15s.",
        traceId: "trace-1",
        hop: "server",
        via: "direct",
      }),
      state: {
        phase: "connected",
        stage: null,
        desired: true,
        network: "online",
        attempt: 1,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      },
    },
    timestamp,
  );

describe("phone connection history", () => {
  it("keeps the disconnect cause after a process restart and includes it in the report", async () => {
    let saved: string | null = null;
    const storage = {
      read: async () => saved,
      write: async (value: string) => {
        saved = value;
      },
    };
    await makeConnectionLog(storage).append(event());
    const records = await makeConnectionLog(storage).read("fred");
    expect(records[0]?.fields).toMatchObject({
      reason: "transport",
      error: "Fred stopped responding for 15s.",
      traceId: "trace-1",
      routes: "https://fred.example:8449",
    });
    const report = formatConnectionLog(records, { version: "2.1.0", build: "37" });
    expect(report).toContain("2026-10-29T05:00:00.000Z");
    expect(report).toContain("Fred stopped responding for 15s.");
    expect(report).not.toContain("private-token");
    expect(report).not.toContain("password");
  });

  it("serializes concurrent events, retains shared network context and limits history", async () => {
    let saved: string | null = null;
    const log = makeConnectionLog({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
    });
    await Promise.all(
      Array.from({ length: CONNECTION_LOG_LIMIT + 2 }, (_, index) =>
        log.append({ ...event(), fields: { index } }),
      ),
    );
    expect((await log.read()).map((record) => record.fields.index)).toEqual(
      Array.from({ length: CONNECTION_LOG_LIMIT }, (_, index) => index + 2),
    );
    await log.append({ ...event(), kind: "network", environmentId: null });
    expect(await log.read("other")).toHaveLength(1);
  });

  it("expires old history and recovers from malformed stored data", async () => {
    let saved: string | null = "invalid";
    const log = makeConnectionLog({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
    });
    await log.append(event("2026-10-01T00:00:00.000Z"));
    await log.append(event());
    expect(await log.read()).toEqual([event()]);
  });

  it("redacts credentials in URLs, authorization headers and token fields", () => {
    const detail = redactConnectionDetail(
      "GET https://name:pass@fred.example/ws?ticket=hidden Authorization: Bearer abc token=def code=123456",
    );
    expect(detail).not.toMatch(/hidden|abc|def|123456|name:pass/);
    expect(detail).toContain("https://fred.example");
  });
});
