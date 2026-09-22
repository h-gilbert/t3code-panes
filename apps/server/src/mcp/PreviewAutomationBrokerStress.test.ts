import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationBusyError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

/**
 * Load tests for the per-tab drive claim. The property that matters is that two
 * provider sessions never hold one tab at the same time, and that nothing leaks
 * a claim — a leak is indistinguishable from the environment-wide lease this
 * replaced, since every later interaction on that tab would be refused forever.
 */

const environmentId = EnvironmentId.make("environment-1");

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const makeScope = (index: number): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: ThreadId.make(`thread-${index}`),
  providerSessionId: `provider-session-${index}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) =>
      event.type === "connected"
        ? Result.failVoid
        : Result.succeed({ ...event.request, connectionId: event.connectionId }),
    ),
  );

/** Deterministic interleaving: a seeded generator keeps a failure reproducible. */
const makeRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
};

const EXCLUSIVE: ReadonlyArray<PreviewAutomationOperation> = [
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "navigate",
];
const PASSIVE: ReadonlyArray<PreviewAutomationOperation> = ["status", "snapshot", "waitFor"];

it.effect(
  "never lets two sessions drive one tab, across many sessions contending for few tabs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const sessionCount = 8;
        const tabCount = 3;
        const roundsPerSession = 40;
        const tabIds = Array.from({ length: tabCount }, (_, index) =>
          PreviewTabId.make(`tab-${index}`),
        );
        // Who is mid-request on each tab, as the host sees it. The broker's claim
        // is what must keep this to one session per tab.
        const driversByTab = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
        const overlaps = yield* Ref.make<ReadonlyArray<string>>([]);
        const random = makeRandom(20260920);

        const requests = requestsFrom(yield* broker.connect(makeHost()));
        yield* Stream.runForEach(requests, (request) =>
          Effect.gen(function* () {
            const tabId = request.tabId;
            const driver = request.threadId;
            const exclusive = !PASSIVE.includes(request.operation);
            if (exclusive && tabId) {
              const conflict = yield* Ref.modify(driversByTab, (drivers) => {
                const current = drivers.get(tabId);
                return [
                  current !== undefined && current !== driver ? current : undefined,
                  new Map(drivers).set(tabId, driver),
                ] as const;
              });
              if (conflict !== undefined) {
                yield* Ref.update(overlaps, (found) => [
                  ...found,
                  `${tabId}: ${conflict} and ${driver}`,
                ]);
              }
            }
            // Yield enough times that concurrent requests genuinely overlap
            // rather than completing in arrival order.
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            if (exclusive && tabId) {
              yield* Ref.update(driversByTab, (drivers) => {
                const next = new Map(drivers);
                if (next.get(tabId) === driver) next.delete(tabId);
                return next;
              });
            }
            yield* broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: { tabId },
            });
          }).pipe(Effect.forkScoped),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        let busy = 0;
        let succeeded = 0;
        const sessions = Array.from({ length: sessionCount }, (_, index) => {
          const scope = makeScope(index);
          return Effect.gen(function* () {
            for (let round = 0; round < roundsPerSession; round += 1) {
              const tabId = tabIds[Math.floor(random() * tabCount)]!;
              const pool = random() < 0.75 ? EXCLUSIVE : PASSIVE;
              const operation = pool[Math.floor(random() * pool.length)]!;
              const outcome = yield* broker
                .invoke<{ tabId?: PreviewTabId }>({ scope, operation, input: {}, tabId })
                .pipe(
                  Effect.as("ok" as const),
                  Effect.catch((error) => Effect.succeed(error)),
                );
              if (outcome === "ok") {
                succeeded += 1;
                continue;
              }
              // Contention is expected; anything else is a real defect.
              expect(outcome).toBeInstanceOf(PreviewAutomationBusyError);
              expect(PASSIVE).not.toContain(operation);
              busy += 1;
            }
          });
        });
        yield* Effect.all(sessions, { concurrency: "unbounded" });

        expect(yield* Ref.get(overlaps)).toEqual([]);
        expect(succeeded + busy).toBe(sessionCount * roundsPerSession);
        // A run that never contended would prove nothing about the guard.
        expect(busy).toBeGreaterThan(0);
        // Every claim is released once the traffic stops.
        for (const tabId of tabIds) {
          expect(yield* broker.readHold({ scope: makeScope(99), tabId })).toBeUndefined();
        }
      }),
    ),
  { timeout: 60_000 },
);

it.effect("releases claims when contending requests are interrupted mid-flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const tabId = PreviewTabId.make("tab-interrupted");
      // Never respond: every request stays in flight until its fiber is killed.
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(requests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      for (let round = 0; round < 50; round += 1) {
        const scope = makeScope(round);
        const driving = yield* broker
          .invoke<void>({ scope, operation: "click", input: {}, tabId })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(yield* broker.readHold({ scope: makeScope(999), tabId })).toMatchObject({
          providerSessionId: scope.providerSessionId,
        });

        yield* Fiber.interrupt(driving);
        yield* Effect.yieldNow;
        // The next session must be able to take the tab immediately.
        expect(yield* broker.readHold({ scope: makeScope(999), tabId })).toBeUndefined();
      }
    }),
  ),
);

it.effect("keeps separate tabs fully parallel while one tab is saturated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const busyTabId = PreviewTabId.make("tab-busy");
      const freeTabIds = Array.from({ length: 6 }, (_, index) =>
        PreviewTabId.make(`tab-free-${index}`),
      );
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      // The saturated tab never answers; every other tab must be unaffected.
      yield* Stream.runForEach(requests, (request) =>
        (request.tabId === busyTabId
          ? Effect.never
          : broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: { tabId: request.tabId },
            })
        ).pipe(Effect.forkScoped),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker
        .invoke<void>({ scope: makeScope(0), operation: "evaluate", input: {}, tabId: busyTabId })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const results = yield* Effect.all(
        freeTabIds.flatMap((tabId, index) =>
          Array.from({ length: 10 }, () =>
            broker.invoke<{ tabId?: PreviewTabId }>({
              scope: makeScope(index + 1),
              operation: "click",
              input: {},
              tabId,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );

      expect(results).toHaveLength(freeTabIds.length * 10);
      expect(yield* broker.readHold({ scope: makeScope(99), tabId: busyTabId })).toMatchObject({
        providerSessionId: "provider-session-0",
      });
    }),
  ),
);
