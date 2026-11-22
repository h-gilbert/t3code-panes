import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type DesktopPreviewBridge, type EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "~/connection/runtime";
import { readPreparedConnection } from "~/state/session";

class RemoteBrowserTransferError extends Schema.TaggedError<RemoteBrowserTransferError>()(
  "RemoteBrowserTransferError",
  { message: Schema.String },
) {}

/**
 * Maintains the authenticated host lease over the remote environment's WebSocket while
 * Electron's main process handles the bulk HTTP event/command transfers directly.
 */
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
            !bridge.connectRemoteHost ||
            !bridge.fetchRemoteHostCommand ||
            !bridge.onRemoteHostError
          )
            return;
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const failed = yield* Deferred.make<never, RemoteBrowserTransferError>();
          const runFork = Effect.runForkWith(yield* Effect.context<never>());
          let connected = false;
          const unsubscribe = bridge.onRemoteHostError((environmentId) => {
            if (environmentId !== options.environmentId || !connected) return;
            runFork(
              Deferred.fail(
                failed,
                new RemoteBrowserTransferError({ message: "Browser host HTTP transfer failed." }),
              ),
            );
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const wasConnected = connected;
              connected = false;
              unsubscribe();
              if (wasConnected) {
                void bridge.disconnectRemoteHost?.(options.environmentId).catch(() => {});
              }
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
                      const connection = readPreparedConnection(options.environmentId);
                      if (!connection) {
                        throw new Error("Browser host connection is unavailable.");
                      }
                      connected = true;
                      await bridge.connectRemoteHost!({
                        environmentId: options.environmentId,
                        httpBaseUrl: connection.httpBaseUrl,
                        lease: event.connectionId,
                      });
                    } else {
                      await bridge.fetchRemoteHostCommand!({
                        environmentId: options.environmentId,
                        commandId: event.commandId,
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
