import * as NodeCrypto from "node:crypto";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeApnsProviderToken, makeEnvironmentAggregate } from "./SelfHostedNotifications.ts";

const NOW = Date.parse("2026-08-24T00:00:00.000Z");
const NOW_ISO = "2026-08-24T00:00:00.000Z";
const EXPIRED_ISO = "2026-08-23T23:44:00.000Z";

function state(
  phase: RelayAgentActivityState["phase"],
  overrides: Partial<RelayAgentActivityState> = {},
): RelayAgentActivityState {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    projectTitle: "T3 Code",
    threadTitle: "Self-host notifications",
    phase,
    headline: "Working",
    modelTitle: "Codex",
    updatedAt: NOW_ISO,
    deepLink: "/environment-1/thread-1",
    ...overrides,
  };
}

describe("self-hosted notification aggregation", () => {
  it("builds a live activity aggregate from active work", () => {
    const aggregate = makeEnvironmentAggregate([state("running")], NOW);

    expect(aggregate).toMatchObject({
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 1,
      activities: [{ phase: "running", status: "Working" }],
    });
  });

  it("retains a recent terminal row and expires old terminal rows", () => {
    expect(makeEnvironmentAggregate([state("completed")], NOW)).toMatchObject({
      subtitle: "Agent work completed",
      activeCount: 0,
      activities: [{ phase: "completed", status: "Done" }],
    });
    expect(
      makeEnvironmentAggregate([state("completed", { updatedAt: EXPIRED_ISO })], NOW),
    ).toBeNull();
  });
});

describe("self-hosted APNs provider token", () => {
  it("uses the configured Apple team and key identifiers", () => {
    const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const jwt = makeApnsProviderToken(
      {
        teamId: "XJN9V8FD45",
        keyId: "KEY1234567",
        privateKey: Redacted.make(privateKey),
        bundleId: "nz.co.hamishgilbert.t3code",
        environment: "sandbox",
      },
      Math.floor(NOW / 1_000),
    );
    const [encodedHeader, encodedPayload] = jwt.split(".");

    const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
    expect(decodeJson(Result.getOrThrow(Encoding.decodeBase64UrlString(encodedHeader!)))).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(
      decodeJson(Result.getOrThrow(Encoding.decodeBase64UrlString(encodedPayload!))),
    ).toMatchObject({
      iss: "XJN9V8FD45",
    });
  });
});
