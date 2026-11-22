import { DesktopBrowserCommand, type DesktopBrowserEvent } from "@t3tools/contracts";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import { createRemoteBrowserEventQueue } from "./remoteBrowserEventQueue.ts";

const TRANSFER_TIMEOUT_MS = 60_000;
const decodeCommand = Schema.decodeUnknownSync(DesktopBrowserCommand);

export type RemoteBrowserFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class RemoteBrowserTransferError extends Schema.TaggedError<RemoteBrowserTransferError>()(
  "RemoteBrowserTransferError",
  { message: Schema.String },
) {}

export interface RemoteBrowserTransferConnection {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
  readonly lease: string;
  readonly ownerWebContentsId?: number | undefined;
}

export interface RemoteBrowserTransferFailure {
  readonly environmentId: string;
  readonly ownerWebContentsId?: number | undefined;
}

export class RemoteBrowserTransfer extends Context.Service<
  RemoteBrowserTransfer,
  {
    readonly connect: (input: RemoteBrowserTransferConnection) => Effect.Effect<void>;
    readonly disconnect: (environmentId: string) => Effect.Effect<void>;
    readonly disconnectOwner: (ownerWebContentsId: number) => Effect.Effect<void>;
    readonly fetchCommand: (input: {
      readonly environmentId: string;
      readonly commandId: string;
    }) => Effect.Effect<void, RemoteBrowserTransferError>;
    readonly errors: Stream.Stream<RemoteBrowserTransferFailure>;
  }
>()("@t3tools/desktop/preview/RemoteBrowserTransfer") {}

interface ActiveTransfer {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
  readonly lease: string;
  readonly ownerWebContentsId?: number | undefined;
  readonly abort: () => void;
  readonly signal: AbortSignal;
  readonly queue: ReturnType<typeof createRemoteBrowserEventQueue>;
}

const defaultFetch: RemoteBrowserFetch = (url, init) => Electron.net.fetch(url, init);

async function runTransferRequest(
  fetchImpl: RemoteBrowserFetch,
  entry: ActiveTransfer,
  path: string,
  body?: readonly DesktopBrowserEvent[],
): Promise<unknown> {
  const response = await fetchImpl(
    new URL(`/api/preview-browser-host/${path}`, entry.httpBaseUrl).href,
    {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      headers: {
        authorization: `T3Browser ${entry.lease}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([entry.signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]),
    },
  );
  if (!response.ok) {
    throw new Error(`Browser host transfer failed (${response.status}).`);
  }
  return body === undefined ? response.json() : undefined;
}

function createActiveTransfer(
  input: RemoteBrowserTransferConnection,
  fetchImpl: RemoteBrowserFetch,
  isCurrent: (entry: ActiveTransfer) => boolean,
  onError: (entry: ActiveTransfer) => void,
): ActiveTransfer {
  const controller = new AbortController();
  const entry: ActiveTransfer = {
    environmentId: input.environmentId,
    httpBaseUrl: input.httpBaseUrl,
    lease: input.lease,
    ownerWebContentsId: input.ownerWebContentsId,
    signal: controller.signal,
    abort: () => controller.abort(),
    queue: createRemoteBrowserEventQueue(
      async (batch) => {
        if (!isCurrent(entry)) return;
        await runTransferRequest(fetchImpl, entry, "events", batch);
      },
      () => {
        if (!isCurrent(entry)) return;
        onError(entry);
      },
    ),
  };
  return entry;
}

/**
 * Moves remote browser CDP frames and command payloads directly between Electron's main
 * process and the remote server's private lease-protected HTTP endpoints, avoiding IPC
 * bounces through any renderer window.
 */
export const make = Effect.fn("RemoteBrowserTransfer.make")(function* (options?: {
  readonly fetch?: RemoteBrowserFetch;
}) {
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const fetchImpl = options?.fetch ?? defaultFetch;
  const errors = yield* PubSub.unbounded<RemoteBrowserTransferFailure>();
  const active = new Map<string, ActiveTransfer>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const teardown = (entry: ActiveTransfer) => {
    if (active.get(entry.environmentId) === entry) {
      active.delete(entry.environmentId);
    }
    entry.abort();
    entry.queue.close();
  };

  yield* browserHost.remoteEvents.pipe(
    Stream.runForEach(({ environmentId, event }) =>
      Effect.sync(() => {
        active.get(environmentId)?.queue.enqueue(event);
      }),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of active.values()) {
        entry.abort();
        entry.queue.close();
      }
      active.clear();
    }),
  );

  const connect = Effect.fn("RemoteBrowserTransfer.connect")(function* (
    input: RemoteBrowserTransferConnection,
  ) {
    const previous = active.get(input.environmentId);
    if (previous !== undefined) {
      teardown(previous);
    }
    const entry = createActiveTransfer(
      input,
      fetchImpl,
      (candidate) => active.get(input.environmentId) === candidate,
      (failedEntry) => {
        teardown(failedEntry);
        runFork(
          browserHost.disconnectRemote(input.environmentId).pipe(
            Effect.andThen(
              PubSub.publish(errors, {
                environmentId: input.environmentId,
                ownerWebContentsId: input.ownerWebContentsId,
              }),
            ),
          ),
        );
      },
    );
    active.set(input.environmentId, entry);
    yield* browserHost.connectRemote(input.environmentId);
  });

  const disconnect = Effect.fn("RemoteBrowserTransfer.disconnect")(function* (
    environmentId: string,
  ) {
    const entry = active.get(environmentId);
    if (entry !== undefined) {
      teardown(entry);
    }
    yield* browserHost.disconnectRemote(environmentId);
  });

  const disconnectOwner = Effect.fn("RemoteBrowserTransfer.disconnectOwner")(function* (
    ownerWebContentsId: number,
  ) {
    const owned = [...active.values()].filter(
      (entry) => entry.ownerWebContentsId === ownerWebContentsId,
    );
    for (const entry of owned) {
      teardown(entry);
      yield* browserHost.disconnectRemote(entry.environmentId);
    }
  });

  const fetchCommand = Effect.fn("RemoteBrowserTransfer.fetchCommand")(function* (input: {
    readonly environmentId: string;
    readonly commandId: string;
  }) {
    const entry = active.get(input.environmentId);
    if (entry === undefined) {
      return yield* new RemoteBrowserTransferError({
        message: "Remote browser host connection is not active.",
      });
    }
    const command = yield* Effect.tryPromise({
      try: async () =>
        decodeCommand(await runTransferRequest(fetchImpl, entry, `command/${input.commandId}`)),
      catch: (cause) =>
        new RemoteBrowserTransferError({
          message: cause instanceof Error ? cause.message : "Browser host command transfer failed.",
        }),
    });
    if (active.get(input.environmentId) !== entry) return;
    yield* browserHost.remoteCommand(input.environmentId, command);
  });

  return RemoteBrowserTransfer.of({
    connect,
    disconnect,
    disconnectOwner,
    fetchCommand,
    errors: Stream.fromPubSub(errors),
  });
});

export const layer = Layer.effect(RemoteBrowserTransfer, make());
