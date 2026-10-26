import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, sessionGrantsScope, type AuthSessionState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("desktop"),
  label: "Mac",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: { _tag: "Bearer", token: "desktop-token" },
  target,
};
const session: AuthSessionState = {
  authenticated: true,
  scopes: ["orchestration:read", "orchestration:operate"],
  permissions: ["orchestration:read", "orchestration:operate"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["desktop-bootstrap"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session_3773",
  },
};

const makeHarness = Effect.fn("TestSession.makeHarness")(function* (
  fetch: typeof globalThis.fetch,
) {
  const preparedRef = yield* SubscriptionRef.make(Option.some(prepared));
  const supervisor = { prepared: preparedRef } as EnvironmentSupervisor["Service"];
  const environmentRegistry = {
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"];
  const requests: Request[] = [];
  const requested = Promise.withResolvers<void>();
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Clock.Clock, clock),
      layerRemoteHttpClient((input, init) => {
        requests.push(new Request(input, init));
        requested.resolve();
        return fetch(input, init);
      }),
    ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createEnvironmentSessionAtoms(runtime);
  const atom = atoms.sessionStateAtom(target.environmentId);
  yield* AtomRegistry.mount(registry, atom);
  return { registry, atom, requests, requested: Effect.promise(() => requested.promise) };
});

describe("environment session state", () => {
  it.effect("loads the desktop grant through its prepared connection", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(() => Promise.resolve(Response.json(session)));
      expect(yield* AtomRegistry.getResult(h.registry, h.atom)).toEqual(session);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.headers.get("authorization")).toBe("Bearer desktop-token");
    }).pipe(Effect.scoped),
  );

  it.effect("recovers from a timed-out permission lookup without replacing the connection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = yield* makeHarness(() =>
        ++attempts === 1
          ? new Promise<Response>(() => {})
          : Promise.resolve(Response.json(session)),
      );
      yield* h.requested;
      yield* TestClock.adjust("6 seconds");
      expect(h.registry.get(h.atom)._tag).not.toBe("Failure");
      yield* TestClock.adjust("1 second");
      const recovered = yield* AtomRegistry.getResult(h.registry, h.atom);
      expect(sessionGrantsScope(recovered, "orchestration:operate")).toBe(true);
      expect(h.requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("recovers from a temporary fetch failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = yield* makeHarness(() =>
        ++attempts === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(Response.json(session)),
      );
      yield* h.requested;
      yield* TestClock.adjust("1 second");
      expect(yield* AtomRegistry.getResult(h.registry, h.atom)).toEqual(session);
      expect(h.requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a genuine permission denial blocked without retrying", () =>
    Effect.gen(function* () {
      const denied = { ...session, scopes: [], permissions: [] };
      const h = yield* makeHarness(() => Promise.resolve(Response.json(denied)));
      const result = yield* AtomRegistry.getResult(h.registry, h.atom);
      expect(sessionGrantsScope(result, "orchestration:operate")).toBe(false);
      yield* TestClock.adjust("1 minute");
      expect(h.requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
