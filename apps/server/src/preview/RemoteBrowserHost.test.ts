import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Channel from "./DesktopBrowserChannel.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Transport from "./DesktopBrowserTransport.ts";

const layer = Channel.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest({ browserHostEnvironmentId: "mac" })),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-browser-" })),
  Layer.provide(NodeServices.layer),
);
const key = { threadId: "thread", tabId: "tab" };

it.effect(
  "binds a selected host to its authenticated session and releases tabs on disconnect",
  () =>
    Effect.gen(function* () {
      const channel = yield* Channel.DesktopBrowserChannel;
      const connected = yield* Deferred.make<string>();
      const host = yield* channel.connectRemote("owner", "mac").pipe(
        Stream.runForEach((event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, event.connectionId)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const connectionId = yield* Deferred.await(connected);
      expect(channel.available).toBe(true);
      const denied = yield* channel
        .remoteEvent("other", connectionId, { type: "attached", ...key })
        .pipe(Effect.flip);
      expect(denied.reason).toBe("disconnected");
      expect(yield* channel.isAttached(key)).toBe(false);
      yield* channel.remoteEvent("owner", connectionId, { type: "attached", ...key });
      expect(yield* channel.isAttached(key)).toBe(true);
      const duplicate = yield* channel
        .connectRemote("other", "mac")
        .pipe(Stream.runDrain, Effect.flip);
      expect(duplicate.reason).toBe("already-connected");
      yield* Fiber.interrupt(host);
      expect(yield* channel.isAttached(key)).toBe(false);
      expect(channel.available).toBe(false);
      const late = yield* channel
        .remoteEvent("owner", connectionId, { type: "attached", ...key })
        .pipe(Effect.flip);
      expect(late.reason).toBe("disconnected");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rejects unselected hosts and events after the host selection changes", () =>
  Effect.gen(function* () {
    const channel = yield* Channel.DesktopBrowserChannel;
    const wrong = yield* channel
      .connectRemote("owner", "other-mac")
      .pipe(Stream.runDrain, Effect.flip);
    expect(wrong.reason).toBe("not-selected");
    const connected = yield* Deferred.make<string>();
    yield* channel.connectRemote("owner", "mac").pipe(
      Stream.runForEach((event) =>
        event.type === "connected" ? Deferred.succeed(connected, event.connectionId) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const connectionId = yield* Deferred.await(connected);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ browserHostEnvironmentId: null });
    const denied = yield* channel
      .remoteEvent("owner", connectionId, { type: "attached", ...key })
      .pipe(Effect.flip);
    expect(denied.reason).toBe("disconnected");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "moves command payloads over lease-protected HTTP and invalidates the lease on disconnect",
  () =>
    Effect.gen(function* () {
      const channel = yield* Channel.DesktopBrowserChannel;
      const connected = yield* Deferred.make<string>();
      const commandReady = yield* Deferred.make<string>();
      const host = yield* channel.connectRemote("owner", "mac").pipe(
        Stream.runForEach((event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, event.connectionId)
            : Deferred.succeed(commandReady, event.commandId),
        ),
        Effect.forkScoped,
      );
      const lease = yield* Deferred.await(connected);
      const request = (path: string, token: string, body?: unknown) =>
        Transport.handler(channel).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`http://localhost/api/preview-browser-host/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                  authorization: `T3Browser ${token}`,
                  "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            ),
          ),
        );
      expect((yield* request("event", "wrong", { type: "attached", ...key })).status).toBe(403);
      expect((yield* request("event", lease, { type: "attached", ...key })).status).toBe(204);
      yield* channel.pointer(key, { phase: "click", x: 1, y: 2 });
      const commandId = yield* Deferred.await(commandReady);
      expect((yield* request(`command/${commandId}`, "wrong")).status).toBe(403);
      const response = yield* request(`command/${commandId}`, lease);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).json())).toEqual({
        type: "pointer",
        ...key,
        phase: "click",
        x: 1,
        y: 2,
      });
      expect((yield* request(`command/${commandId}`, lease)).status).toBe(403);
      yield* Fiber.interrupt(host);
      expect((yield* request("event", lease, { type: "attached", ...key })).status).toBe(403);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
