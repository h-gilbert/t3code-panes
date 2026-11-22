import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as RemoteBrowserTransfer from "./RemoteBrowserTransfer.ts";

const makeDebuggee = (): DesktopBrowserHost.DesktopBrowserTabDebugger => ({
  webContents: {
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    getUserAgent: () => "Mozilla/5.0",
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Electron.WebContents,
  debugger: {
    on: vi.fn(),
    off: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
  } as unknown as Electron.Debugger,
  operation: vi.fn(async () => ({})),
  send: vi.fn(async () => ({})),
});

describe("RemoteBrowserTransfer", () => {
  it.effect("posts remote events and fetches commands directly from main process", () =>
    Effect.gen(function* () {
      const posted = yield* Deferred.make<{
        readonly url: string;
        readonly auth: string | null;
        readonly body: unknown;
      }>();
      const pointerSeen = yield* Deferred.make<{
        readonly phase: "move" | "click";
        readonly x: number;
        readonly y: number;
      }>();
      const fetchStub: RemoteBrowserTransfer.RemoteBrowserFetch = vi.fn(async (url, init) => {
        const headers = new Headers(init?.headers);
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          Deferred.doneUnsafe(
            posted,
            Effect.succeed({ url, auth: headers.get("authorization"), body }),
          );
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({
            type: "pointer",
            threadId: "thread-1",
            tabId: "tab-1",
            phase: "click",
            x: 42,
            y: 24,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const host = yield* DesktopBrowserHost.make;
      const transfer = yield* RemoteBrowserTransfer.make({ fetch: fetchStub }).pipe(
        Effect.provideService(DesktopBrowserHost.DesktopBrowserHost, host),
      );
      yield* host.pointers.pipe(
        Stream.runForEach((entry) => Deferred.succeed(pointerSeen, entry)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      host.attach({ environmentId: "fred", threadId: "thread-1", tabId: "tab-1" }, makeDebuggee());
      yield* transfer.connect({
        environmentId: "fred",
        httpBaseUrl: "https://fred.example",
        lease: "lease-123",
        ownerWebContentsId: 77,
      });

      const sent = yield* Deferred.await(posted);
      expect(sent.url).toBe("https://fred.example/api/preview-browser-host/events");
      expect(sent.auth).toBe("T3Browser lease-123");
      expect(sent.body).toEqual([{ type: "attached", threadId: "thread-1", tabId: "tab-1" }]);

      yield* transfer.fetchCommand({ environmentId: "fred", commandId: "cmd-1" });
      const pointer = yield* Deferred.await(pointerSeen);
      expect(pointer).toMatchObject({ phase: "click", x: 42, y: 24 });

      yield* transfer.disconnectOwner(77);
      expect(yield* host.hasActiveWork).toBe(true); // tab still attached
      host.detach({ environmentId: "fred", threadId: "thread-1", tabId: "tab-1" });
      expect(yield* host.hasActiveWork).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("notifies only the owning renderer and disconnects when event POST fails", () =>
    Effect.gen(function* () {
      const fetchStub: RemoteBrowserTransfer.RemoteBrowserFetch = vi.fn(
        async () => new Response(null, { status: 403 }),
      );
      const host = yield* DesktopBrowserHost.make;
      const transfer = yield* RemoteBrowserTransfer.make({ fetch: fetchStub }).pipe(
        Effect.provideService(DesktopBrowserHost.DesktopBrowserHost, host),
      );
      const failureFiber = yield* transfer.errors.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      host.attach({ environmentId: "air", threadId: "t1", tabId: "tab1" }, makeDebuggee());
      yield* transfer.connect({
        environmentId: "air",
        httpBaseUrl: "https://air.example",
        lease: "expired",
        ownerWebContentsId: 91,
      });

      const [failure] = yield* Fiber.join(failureFiber);
      expect(failure).toEqual({ environmentId: "air", ownerWebContentsId: 91 });
      host.detach({ environmentId: "air", threadId: "t1", tabId: "tab1" });
      expect(yield* host.hasActiveWork).toBe(false);
    }).pipe(Effect.scoped),
  );
});
