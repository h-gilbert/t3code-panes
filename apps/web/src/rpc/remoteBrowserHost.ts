import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  WS_METHODS,
  type DesktopPreviewBridge,
  DesktopBrowserCommand,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Data from "effect/Data";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { readPreparedConnection } from "~/state/session";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "~/connection/runtime";
import { createRemoteBrowserEventQueue } from "./remoteBrowserEventQueue";

class RemoteBrowserTransferError extends Data.TaggedError("RemoteBrowserTransferError")<{
  readonly message: string;
}> {}

const decodeCommand = Schema.decodeUnknownSync(DesktopBrowserCommand);

/** Consume the CDP stream directly: a latest-value UI atom would drop protocol frames. */
export function remoteBrowserHostAtom(options: {
  environmentId: EnvironmentId;
  hostEnvironmentId: EnvironmentId;
  bridge: DesktopPreviewBridge;
}) {
  return connectionAtomRuntime
    .atom(
      Effect.scoped(
        Effect.gen(function* () {
          const { bridge } = options;
          if (
            !bridge.onRemoteHostEvent ||
            !bridge.connectRemoteHost ||
            !bridge.sendRemoteHostCommand
          )
            return;
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const failed = yield* Deferred.make<never, RemoteBrowserTransferError>();
          const runFork = Effect.runForkWith(yield* Effect.context<never>());
          let connectionId: string | null = null;
          const pending = new AbortController();
          const transfer = async (lease: string, path: string, body?: unknown) => {
            const connection = readPreparedConnection(options.environmentId);
            if (!connection) throw new Error("Browser host connection is unavailable.");
            const response = await fetch(
              new URL(`/api/preview-browser-host/${path}`, connection.httpBaseUrl),
              {
                method: body === undefined ? "GET" : "POST",
                credentials: "omit",
                headers: {
                  authorization: `T3Browser ${lease}`,
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.any([pending.signal, AbortSignal.timeout(60_000)]),
              },
            );
            if (!response.ok) throw new Error(`Browser host transfer failed (${response.status}).`);
            return body === undefined ? response.json() : undefined;
          };
          const events = createRemoteBrowserEventQueue(
            async (batch) => {
              if (connectionId) await transfer(connectionId, "events", batch);
            },
            () => {
              runFork(
                Deferred.fail(
                  failed,
                  new RemoteBrowserTransferError({ message: "Browser host HTTP transfer failed." }),
                ),
              );
            },
          );
          const unsubscribe = bridge.onRemoteHostEvent((message) => {
            if (message.environmentId !== options.environmentId || !connectionId) return;
            events.enqueue(message.event);
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.close();
              pending.abort();
              const connected = connectionId !== null;
              connectionId = null;
              unsubscribe();
              if (connected)
                void bridge.disconnectRemoteHost?.(options.environmentId).catch(() => {});
            }),
          );
          yield* registry
            .runStream(
              options.environmentId,
              subscribe(
                WS_METHODS.previewDesktopHostConnect,
                {
                  hostEnvironmentId: options.hostEnvironmentId,
                },
                {
                  retryOnCompletionAfter: "2 seconds",
                  retryExpectedFailureAfter: "2 seconds",
                  onExpectedFailure: () => Effect.void,
                },
              ),
            )
            .pipe(
              Stream.runForEach((event) =>
                Effect.tryPromise({
                  try: async () => {
                    if (event.type === "connected") {
                      connectionId = event.connectionId;
                      await bridge.connectRemoteHost!(options.environmentId);
                    } else {
                      await bridge.sendRemoteHostCommand!({
                        environmentId: options.environmentId,
                        command: decodeCommand(
                          await transfer(connectionId!, `command/${event.commandId}`),
                        ),
                      });
                    }
                  },
                  catch: () =>
                    new RemoteBrowserTransferError({
                      message: "Browser host command transfer failed.",
                    }),
                }),
              ),
              Effect.raceFirst(Deferred.await(failed)),
            );
        }),
      ).pipe(Effect.retry(Schedule.spaced("2 seconds"))),
    )
    .pipe(Atom.setIdleTTL(0));
}
