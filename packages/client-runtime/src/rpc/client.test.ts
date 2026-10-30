import {
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
  type DesktopBrowserHostStreamEvent,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  runStream,
  subscribe,
  subscribeDynamicWithSession,
  EnvironmentRpcRequestObserver,
  request,
} from "./client.ts";

import * as TestClock from "effect/testing/TestClock";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("registers a fresh preview host after completion without replaying requests", () =>
    Effect.gen(function* () {
      const firstCompleted = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const requests: string[] = [];
      const connections: string[] = [];
      let attempts = 0;
      const client = {
        [WS_METHODS.previewDesktopHostConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            const connected: DesktopBrowserHostStreamEvent = {
              type: "connected",
              connectionId: `connection-${attempts}`,
            };
            return attempts === 1
              ? Stream.make(connected, {
                  type: "command",
                  commandId: "timed-out-action",
                } satisfies DesktopBrowserHostStreamEvent).pipe(
                  Stream.ensuring(Deferred.succeed(firstCompleted, undefined)),
                )
              : Stream.succeed(connected).pipe(Stream.concat(Stream.never));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(
        WS_METHODS.previewDesktopHostConnect,
        {
          hostEnvironmentId: TARGET.environmentId,
        },
        { retryOnCompletionAfter: 1_000 },
      ).pipe(
        Stream.runForEach((event) => {
          if (event.type === "command") {
            requests.push(event.commandId);
            return Effect.void;
          }
          connections.push(event.connectionId);
          return connections.length === 2 ? Deferred.succeed(reconnected, undefined) : Effect.void;
        }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstCompleted);
      yield* TestClock.adjust(999);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      expect(attempts).toBe(2);
      yield* Deferred.await(reconnected);
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(requests).toEqual(["timed-out-action"]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("does not re-register an unmounted preview host during the recovery delay", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.previewDesktopHostConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            return Stream.empty.pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(
        WS_METHODS.previewDesktopHostConnect,
        {
          hostEnvironmentId: TARGET.environmentId,
        },
        { retryOnCompletionAfter: 1_000 },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(consumer);
      yield* TestClock.adjust(10_000);
      expect(attempts).toBe(1);
    }),
  );

  it.effect.each(["completion", "transport failure"] as const)(
    "keeps preview recovery tied to the active session after %s",
    (reason) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const nextConnected = yield* Deferred.make<void>();
        let oldAttempts = 0;
        let nextAttempts = 0;
        const firstClient = {
          [WS_METHODS.previewDesktopHostConnect]: () =>
            Stream.suspend(() => {
              oldAttempts += 1;
              return (
                reason === "completion"
                  ? Stream.empty
                  : Stream.fail(
                      new RpcClientError.RpcClientError({
                        reason: new RpcClientError.RpcClientDefect({
                          message: "socket closed",
                          cause: new Error("socket closed"),
                        }),
                      }),
                    )
              ).pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
            }),
        } as unknown as WsRpcProtocolClient;
        const nextClient = {
          [WS_METHODS.previewDesktopHostConnect]: () =>
            Stream.suspend(() => {
              nextAttempts += 1;
              return Stream.fromEffect(Deferred.succeed(nextConnected, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              );
            }),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const consumer = yield* subscribe(
          WS_METHODS.previewDesktopHostConnect,
          {
            hostEnvironmentId: TARGET.environmentId,
          },
          { retryOnCompletionAfter: 1_000 },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(completed);
        if (reason === "transport failure") {
          yield* TestClock.adjust(10_000);
          expect(oldAttempts).toBe(1);
        }
        yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
        yield* Deferred.await(nextConnected);
        yield* TestClock.adjust(10_000);
        expect(oldAttempts).toBe(1);
        expect(nextAttempts).toBe(1);
        yield* Fiber.interrupt(consumer);
      }),
  );

  it.effect("reattaches a completed preview host stream in the same session", () =>
    Effect.gen(function* () {
      const firstConnected = yield* Deferred.make<void>();
      const firstEnded = yield* Deferred.make<void>();
      const reattached = yield* Deferred.make<void>();
      const firstQueue = yield* Queue.unbounded<never, Cause.Done>();
      let connections = 0;
      const client = {
        [WS_METHODS.previewDesktopHostConnect]: () => {
          connections += 1;
          if (connections === 1) {
            return Stream.fromEffect(Deferred.succeed(firstConnected, undefined)).pipe(
              Stream.drain,
              Stream.concat(
                Stream.fromQueue(firstQueue).pipe(
                  Stream.ensuring(Deferred.succeed(firstEnded, undefined)),
                ),
              ),
            );
          }
          return Stream.fromEffect(Deferred.succeed(reattached, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribe(
        WS_METHODS.previewDesktopHostConnect,
        { hostEnvironmentId: TARGET.environmentId },
        { retryOnCompletionAfter: 1_000 },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstConnected);
      yield* Queue.end(firstQueue);
      yield* Deferred.await(firstEnded);
      yield* TestClock.adjust(1_000);
      yield* Deferred.await(reattached);
      expect(connections).toBe(2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("reuses the session config stream instead of opening a duplicate subscription", () =>
    Effect.gen(function* () {
      const event: ServerConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      };
      let duplicateSubscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => {
          duplicateSubscriptions += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          subscribeServerConfig: () => Stream.succeed(event),
        }),
      );

      const received = yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(received).toEqual(Option.some(event));
      expect(duplicateSubscriptions).toBe(0);
    }),
  );

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, environmentLabel, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${environmentLabel}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${TARGET.label}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (;;) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Queue.take(subscriptionChanges);
        }
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      while (subscriptions.length < 1) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalMetadata]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const observedFailures: Error[] = [];
      const failureObserved = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalMetadata,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
              Deferred.doneUnsafe(failureObserved, Effect.void);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(failureObserved);

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalMetadata]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalMetadata,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );
});
