// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/** Playwright needs a CDP WebSocket; the secret loopback endpoint relays desktop debugger frames over bootstrap fds. */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  type DesktopBrowserPrivateOperation,
  DesktopBrowserHostError,
  type DesktopBrowserHostStreamEvent,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export class DesktopBrowserOperationError extends Schema.TaggedError<DesktopBrowserOperationError>()(
  "DesktopBrowserOperationError",
  { message: Schema.String },
) {}

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    readonly available: boolean;
    readonly connectRemote: (
      sessionId: string,
      hostEnvironmentId: string,
    ) => Stream.Stream<DesktopBrowserHostStreamEvent, DesktopBrowserHostError>;
    readonly remoteEvent: (
      sessionId: string,
      connectionId: string,
      event: DesktopBrowserEvent,
    ) => Effect.Effect<void, DesktopBrowserHostError>;
    readonly readRemoteCommand: (
      connectionId: string,
      commandId: string,
    ) => Effect.Effect<DesktopBrowserCommandType, DesktopBrowserHostError>;
    readonly receiveRemoteEvent: (
      connectionId: string,
      event: DesktopBrowserEvent,
    ) => Effect.Effect<void, DesktopBrowserHostError>;
    readonly operation: (
      key: DesktopTabKey,
      request: DesktopBrowserPrivateOperation,
    ) => Effect.Effect<unknown, DesktopBrowserOperationError>;
    /**
     * Subscribes before it checks, so an attach landing in between is never
     * missed.
     */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Set<string>();
  const inbound = new Map<string, Queue.Queue<string>>();
  const pending = new Map<
    string,
    { key: string; deferred: Deferred.Deferred<unknown, DesktopBrowserOperationError> }
  >();
  const writeLock = yield* Semaphore.make(1);

  let remoteHost:
    | {
        sessionId: string;
        hostEnvironmentId: string;
        connectionId: string;
        queue: Queue.Queue<DesktopBrowserHostStreamEvent>;
        commands: Map<string, DesktopBrowserCommandType>;
      }
    | undefined;

  const command = (message: DesktopBrowserCommandType) =>
    Effect.suspend(() => {
      if (remoteHost) {
        const commandId = NodeCrypto.randomUUID();
        remoteHost.commands.set(commandId, message);
        return Queue.offer(remoteHost.queue, { type: "command", commandId }).pipe(Effect.asVoid);
      }
      if (controlFd === undefined) return Effect.void;
      return writeLock.withPermits(1)(
        encodeCommand(message).pipe(
          Effect.flatMap((line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))),
          Effect.catchCause((cause) =>
            Effect.logWarning("desktop browser command failed", { cause }),
          ),
        ),
      );
    });

  const receive = (event: DesktopBrowserEvent) => {
    const key = { threadId: event.threadId, tabId: event.tabId };
    const id = keyOf(key);
    switch (event.type) {
      case "operationResult": {
        const waiting = pending.get(event.requestId);
        if (!waiting || waiting.key !== id) return Effect.void;
        return event.error === undefined
          ? Deferred.succeed(waiting.deferred, event.result)
          : Deferred.fail(
              waiting.deferred,
              new DesktopBrowserOperationError({ message: event.error }),
            );
      }
      case "cdp": {
        const queue = inbound.get(id);
        return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
      }
      case "attached":
        attachedTabs.add(id);
        return PubSub.publish(changes, { key, attached: true });
      case "detached": {
        attachedTabs.delete(id);
        const queue = inbound.get(id);
        return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
          Effect.andThen(
            Effect.forEach(
              [...pending.values()].filter((entry) => entry.key === id),
              (entry) =>
                Deferred.fail(
                  entry.deferred,
                  new DesktopBrowserOperationError({ message: "Desktop browser tab detached." }),
                ),
              { discard: true },
            ),
          ),
          Effect.andThen(PubSub.publish(changes, { key, attached: false })),
        );
      }
    }
  };

  if (inputFd !== undefined && controlFd !== undefined) {
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    yield* NodeStream.fromReadable<Uint8Array, Error>({
      evaluate: () => readable,
      closeOnDone: true,
      onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
      Stream.runForEach((event) => (Option.isSome(event) ? receive(event.value) : Effect.void)),
      Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
      Effect.forkScoped,
    );
  }

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const id = keyOf(key);
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<string>();
    inbound.set(id, queue);
    // A detach before this registration shut down no queue, so check again.
    if (!attachedTabs.has(id)) {
      inbound.delete(id);
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (inbound.get(id) === queue) inbound.delete(id);
        yield* Queue.shutdown(queue);
        yield* command({ type: "release", ...key });
      }),
    );
    // The relay serves one Playwright connection; a second would see the first's sessions.
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          if (connected) return;
          connected = true;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          yield* Stream.fromQueue(queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.forkScoped,
          );
          const decoder = new TextDecoder();
          return yield* reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
                { discard: true },
              ),
            ),
            Effect.forever,
          );
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  const remoteEvent = Effect.fn("remoteEvent")(function* (
    sessionId: string,
    connectionId: string,
    event: DesktopBrowserEvent,
  ) {
    const selected = yield* settings.getSettings.pipe(Effect.orDie);
    if (
      !remoteHost ||
      selected.browserHostEnvironmentId !== remoteHost.hostEnvironmentId ||
      remoteHost.sessionId !== sessionId ||
      remoteHost.connectionId !== connectionId
    )
      return yield* new DesktopBrowserHostError({ reason: "disconnected" });
    yield* receive(event);
  });

  return DesktopBrowserChannel.of({
    readRemoteCommand: Effect.fn("DesktopBrowserChannel.readRemoteCommand")(
      function* (connectionId, commandId) {
        const selected = yield* settings.getSettings.pipe(Effect.orDie);
        if (
          !remoteHost ||
          remoteHost.connectionId !== connectionId ||
          selected.browserHostEnvironmentId !== remoteHost.hostEnvironmentId
        )
          return yield* new DesktopBrowserHostError({ reason: "disconnected" });
        const command = remoteHost.commands.get(commandId);
        if (!command) return yield* new DesktopBrowserHostError({ reason: "disconnected" });
        remoteHost.commands.delete(commandId);
        return command;
      },
    ),
    receiveRemoteEvent: Effect.fn("DesktopBrowserChannel.receiveRemoteEvent")(
      (connectionId, event) =>
        Effect.suspend(() =>
          remoteHost
            ? remoteEvent(remoteHost.sessionId, connectionId, event)
            : Effect.fail(new DesktopBrowserHostError({ reason: "disconnected" })),
        ),
    ),
    get available() {
      return inputFd !== undefined || remoteHost !== undefined;
    },
    connectRemote: (sessionId, hostEnvironmentId) =>
      Stream.unwrap(
        Effect.acquireRelease(
          writeLock.withPermits(1)(
            Effect.gen(function* () {
              const selected = yield* settings.getSettings.pipe(Effect.orDie);
              if (inputFd !== undefined || selected.browserHostEnvironmentId !== hostEnvironmentId)
                return yield* new DesktopBrowserHostError({ reason: "not-selected" });
              if (remoteHost)
                return yield* new DesktopBrowserHostError({ reason: "already-connected" });
              const queue = yield* Queue.unbounded<DesktopBrowserHostStreamEvent>();
              const host = {
                sessionId,
                hostEnvironmentId,
                connectionId: NodeCrypto.randomUUID(),
                commands: new Map<string, DesktopBrowserCommandType>(),
                queue,
              };
              remoteHost = host;
              yield* Queue.offer(queue, { type: "connected", connectionId: host.connectionId });
              return host;
            }),
          ),
          (host) =>
            Effect.gen(function* () {
              if (remoteHost !== host) return;
              remoteHost = undefined;
              for (const id of attachedTabs) {
                const [threadId, tabId] = id.split("\u0000");
                if (threadId && tabId) yield* receive({ type: "detached", threadId, tabId });
              }
              yield* Queue.shutdown(host.queue);
            }),
        ).pipe(
          Effect.map((host) =>
            Stream.fromQueue(host.queue).pipe(
              Stream.merge(
                settings.streamChanges.pipe(
                  Stream.filter(
                    (value) => value.browserHostEnvironmentId !== host.hostEnvironmentId,
                  ),
                  Stream.mapEffect(() =>
                    Effect.fail(new DesktopBrowserHostError({ reason: "not-selected" })),
                  ),
                ),
                { haltStrategy: "left" },
              ),
            ),
          ),
        ),
      ),
    remoteEvent,
    operation: Effect.fn("DesktopBrowserChannel.operation")(function* (key, request) {
      if (!attachedTabs.has(keyOf(key)))
        return yield* new DesktopBrowserOperationError({
          message: "Desktop browser tab detached.",
        });
      const requestId = NodeCrypto.randomUUID();
      const deferred = yield* Deferred.make<unknown, DesktopBrowserOperationError>();
      pending.set(requestId, { key: keyOf(key), deferred });
      return yield* command({ type: "operation", ...key, requestId, request }).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeout("60 seconds"),
        Effect.mapError((error) => new DesktopBrowserOperationError({ message: error.message })),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(requestId);
          }),
        ),
      );
    }),
    awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function (key) {
      return Effect.sync(() => attachedTabs.has(keyOf(key)));
    }),
    endpoint,
    turn: Effect.fn("DesktopBrowserChannel.turn")(function (threadId, active) {
      return command({ type: "turn", threadId, active });
    }),
    pointer: Effect.fn("DesktopBrowserChannel.pointer")(function (key, pointer) {
      return command({ type: "pointer", ...key, ...pointer });
    }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
