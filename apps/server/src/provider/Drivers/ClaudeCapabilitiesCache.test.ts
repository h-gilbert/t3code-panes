import { assert, describe, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { readCapabilitiesCache } from "./ClaudeDriver.ts";

/**
 * Cache shaped like the driver's: one entry, a five-minute TTL, and a lookup
 * whose results are driven by `results` so a test can make the first probe fail
 * and the second succeed.
 */
const makeProbeCache = (results: Ref.Ref<ReadonlyArray<string | undefined>>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const cache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (_key: string) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(calls, (n) => n + 1);
          const queued = yield* Ref.get(results);
          return queued[index];
        }),
    });
    return { cache, calls };
  });

describe("readCapabilitiesCache", () => {
  it.effect("probes again after a failure instead of serving it for the whole TTL", () =>
    Effect.gen(function* () {
      const results = yield* Ref.make<ReadonlyArray<string | undefined>>([undefined, "Claude Max"]);
      const { cache, calls } = yield* makeProbeCache(results);

      // A probe that failed (e.g. timed out because the machine slept mid-probe).
      assert.strictEqual(yield* readCapabilitiesCache(cache, "key"), undefined);
      assert.strictEqual(yield* Ref.get(calls), 1);

      // The very next health check re-probes rather than replaying the failure,
      // so the provider recovers without waiting out the TTL.
      assert.strictEqual(yield* readCapabilitiesCache(cache, "key"), "Claude Max");
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  );

  it.effect("still caches a successful probe for the TTL", () =>
    Effect.gen(function* () {
      const results = yield* Ref.make<ReadonlyArray<string | undefined>>(["Claude Max", "second"]);
      const { cache, calls } = yield* makeProbeCache(results);

      assert.strictEqual(yield* readCapabilitiesCache(cache, "key"), "Claude Max");
      yield* TestClock.adjust(Duration.minutes(4));
      assert.strictEqual(yield* readCapabilitiesCache(cache, "key"), "Claude Max");
      assert.strictEqual(yield* Ref.get(calls), 1);

      // Past the TTL the entry expires as before.
      yield* TestClock.adjust(Duration.minutes(2));
      assert.strictEqual(yield* readCapabilitiesCache(cache, "key"), "second");
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  );
});
