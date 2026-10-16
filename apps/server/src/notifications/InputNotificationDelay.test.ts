import { expect, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Delay from "./InputNotificationDelay.ts";

const thread = ThreadId.make("thread");

it("checks the saved question at delivery time, including its age and identity", () => {
  const createdAt = DateTime.makeUnsafe("2026-10-16T00:00:00Z");
  const pending = {
    archivedAt: null,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("question"),
      kind: "user_input" as const,
      createdAt,
    },
  };
  const dueAt = createdAt.epochMilliseconds + 90_000;
  expect(Delay.isDue(pending, "question", dueAt - 1)).toBe(false);
  expect(Delay.isDue(pending, "question", dueAt)).toBe(true);
  expect(Delay.isDue({ ...pending, pendingRuntimeRequest: null }, "question", dueAt)).toBe(false);
  expect(Delay.isDue(pending, "old-question", dueAt)).toBe(false);
  expect(Delay.isDue({ ...pending, archivedAt: createdAt }, "question", dueAt)).toBe(false);
  expect(Delay.isDue(null, "question", dueAt)).toBe(false);
});

it.effect("waits 90 seconds from the question and wakes only once despite repeated updates", () =>
  Effect.gen(function* () {
    const sent: string[] = [];
    const woke = yield* Deferred.make<void>();
    const delay = yield* Delay.make((_thread, id) =>
      Effect.sync(() => sent.push(id)).pipe(Effect.andThen(Deferred.succeed(woke, undefined))),
    );
    const request = { id: "question", createdAt: yield* DateTime.now };
    yield* delay.update(thread, request);
    yield* TestClock.adjust("89 seconds");
    expect(sent).toEqual([]);
    yield* delay.update(thread, request);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(woke);
    expect(sent).toEqual(["question"]);
    yield* delay.update(thread, request);
    yield* TestClock.adjust("90 seconds");
    expect(sent).toEqual(["question"]);
  }).pipe(Effect.scoped),
);

it.effect("cancels answered questions and gives a replacement question its own deadline", () =>
  Effect.gen(function* () {
    const sent: string[] = [];
    const woke = yield* Deferred.make<void>();
    const delay = yield* Delay.make((_thread, id) =>
      Effect.sync(() => sent.push(id)).pipe(Effect.andThen(Deferred.succeed(woke, undefined))),
    );
    yield* delay.update(thread, { id: "answered", createdAt: yield* DateTime.now });
    yield* TestClock.adjust("30 seconds");
    yield* delay.update(thread, null);
    yield* TestClock.adjust("90 seconds");
    expect(sent).toEqual([]);
    yield* delay.update(thread, { id: "replaced", createdAt: yield* DateTime.now });
    yield* TestClock.adjust("30 seconds");
    yield* delay.update(thread, { id: "replacement", createdAt: yield* DateTime.now });
    yield* TestClock.adjust("60 seconds");
    expect(sent).toEqual([]);
    yield* TestClock.adjust("30 seconds");
    yield* Deferred.await(woke);
    expect(sent).toEqual(["replacement"]);
  }).pipe(Effect.scoped),
);

it.effect("uses the original creation time when recovering an outstanding question", () =>
  Effect.gen(function* () {
    const woke = yield* Deferred.make<void>();
    const createdAt = yield* DateTime.now;
    yield* TestClock.adjust("80 seconds");
    const delay = yield* Delay.make(() => Deferred.succeed(woke, undefined).pipe(Effect.asVoid));
    yield* delay.update(thread, { id: "recovered", createdAt });
    yield* TestClock.adjust("9 seconds");
    expect(yield* Deferred.isDone(woke)).toBe(false);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(woke);
  }).pipe(Effect.scoped),
);
