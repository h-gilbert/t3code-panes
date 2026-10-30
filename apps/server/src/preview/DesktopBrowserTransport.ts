import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Schema from "effect/Schema";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const decodeEvents = Schema.decodeUnknownEffect(
  Schema.Array(DesktopBrowserEvent).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
);
const prefix = "/api/preview-browser-host";

/**
 * The lease is an ephemeral bearer capability issued only by the authorized host
 * subscription. Closing/revoking that subscription invalidates it. Keeping it in
 * a header avoids URL/history logs; no cookies or public CDP listener are used.
 * File data and large CDP frames stay off the conversation WebSocket.
 */
export const handler = Effect.fn("DesktopBrowserTransport.handler")(
  function* (channel: DesktopBrowserChannel.DesktopBrowserChannel["Service"]) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("T3Browser ")) return HttpServerResponse.empty({ status: 401 });
    const lease = authorization.slice("T3Browser ".length);
    const path = request.url.split("?")[0] ?? "";
    if (request.method === "POST" && path === `${prefix}/event`) {
      const event = yield* request.json.pipe(Effect.flatMap(decodeEvent));
      yield* channel.receiveRemoteEvent(lease, event);
      return HttpServerResponse.empty({ status: 204 });
    }
    if (request.method === "POST" && path === `${prefix}/events`) {
      const events = yield* request.json.pipe(Effect.flatMap(decodeEvents));
      yield* Effect.forEach(events, (event) => channel.receiveRemoteEvent(lease, event), {
        discard: true,
      });
      return HttpServerResponse.empty({ status: 204 });
    }
    if (request.method === "GET" && path.startsWith(`${prefix}/command/`)) {
      const command = yield* channel.readRemoteCommand(
        lease,
        path.slice(`${prefix}/command/`.length),
      );
      return yield* HttpServerResponse.json(command, { headers: { "cache-control": "no-store" } });
    }
    return HttpServerResponse.empty({ status: 404 });
  },
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(64 * 1024 * 1024)),
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
);

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    yield* router.add("GET", `${prefix}/command/*`, handler(channel));
    yield* router.add("POST", `${prefix}/event`, handler(channel));
    yield* router.add("POST", `${prefix}/events`, handler(channel));
  }),
);
