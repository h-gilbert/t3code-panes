import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopBrowserEvent } from "@t3tools/contracts";
import { createRemoteBrowserEventQueue } from "./remoteBrowserEventQueue";

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const event = (id: number): DesktopBrowserEvent => ({
  type: "cdp",
  threadId: "thread",
  tabId: "tab",
  message: JSON.stringify({ id }),
});

describe("remote browser event transfer", () => {
  it("transfers a busy page's 1,734 ordered frames in 28 requests", async () => {
    const batches: (readonly DesktopBrowserEvent[])[] = [];
    const done = deferred<void>();
    let received = 0;
    const queue = createRemoteBrowserEventQueue(
      async (batch) => {
        batches.push(batch);
        received += batch.length;
        if (received === 1734) done.resolve(undefined);
      },
      (cause) => done.reject(cause),
    );
    const frames = Array.from({ length: 1734 }, (_, id) => event(id));
    frames.forEach(queue.enqueue);
    await done.promise;
    expect(batches).toHaveLength(28);
    expect(batches.flat()).toEqual(frames);
    queue.close();
  });

  it("queues arrivals during a network request without concurrent or reordered sends", async () => {
    const first = deferred<void>();
    const started = deferred<void>();
    const second = deferred<void>();
    const batches: (readonly DesktopBrowserEvent[])[] = [];
    const queue = createRemoteBrowserEventQueue(
      async (batch) => {
        batches.push(batch);
        if (batches.length === 1) {
          started.resolve(undefined);
          await first.promise;
        } else second.resolve(undefined);
      },
      (cause) => second.reject(cause),
    );
    queue.enqueue(event(1));
    await started.promise;
    queue.enqueue(event(2));
    queue.enqueue(event(3));
    expect(batches).toEqual([[event(1)]]);
    first.resolve(undefined);
    await second.promise;
    expect(batches).toEqual([[event(1)], [event(2), event(3)]]);
    queue.close();
  });

  it("stops queued sends after a transfer fails and reports the failure once", async () => {
    const failed = deferred<unknown>();
    const failure = new Error("disconnected");
    const send = vi.fn(async () => {
      throw failure;
    });
    const queue = createRemoteBrowserEventQueue(send, failed.resolve);
    Array.from({ length: 100 }, (_, id) => event(id)).forEach(queue.enqueue);
    expect(await failed.promise).toBe(failure);
    queue.enqueue(event(101));
    await Promise.resolve(undefined);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send queued events after the connection closes", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const send = vi.fn(async () => {
      started.resolve(undefined);
      await release.promise;
    });
    const error = vi.fn();
    const queue = createRemoteBrowserEventQueue(send, error);
    queue.enqueue(event(1));
    await started.promise;
    queue.enqueue(event(2));
    queue.close();
    release.resolve(undefined);
    await release.promise;
    queue.enqueue(event(3));
    await Promise.resolve(undefined);
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps large CDP frames in separate bounded requests", async () => {
    const batches: (readonly DesktopBrowserEvent[])[] = [];
    const done = deferred<void>();
    const large = { ...event(1), message: "x".repeat(5 * 1024 * 1024) };
    const queue = createRemoteBrowserEventQueue(
      async (batch) => {
        batches.push(batch);
        if (batches.length === 2) done.resolve(undefined);
      },
      (cause) => done.reject(cause),
    );
    queue.enqueue(large);
    queue.enqueue(large);
    await done.promise;
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    queue.close();
  });
});
