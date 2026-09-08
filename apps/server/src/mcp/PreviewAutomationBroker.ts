import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationBusyError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "./McpInvocationContext.ts";

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  readonly context: PreviewAutomationRequestErrorContext;
}

/**
 * A lease pinning one provider session to one desktop runtime. It lives exactly
 * as long as the connection it names: `connectionId`/`queue` identity is what
 * makes a lease valid, so a disconnected or replaced host is dropped on the next
 * lookup. The lease deliberately has no clock of its own — it used to inherit
 * the MCP credential's expiry, which coupled host stickiness to an unrelated
 * auth deadline and could migrate a live session to another runtime mid-flow.
 */
interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly queue: ClientConnection["queue"];
  readonly tabId?: PreviewTabId;
  readonly tabSequence?: number;
}

/**
 * The provider session that currently holds a shared browser environment for
 * exclusive interaction, plus when it last drove it. Keyed per environment (one
 * shared surface per environment) rather than per connection, so it survives a
 * host reconnect within the idle window and expresses "another session owns the
 * browser" — something the per-session `assignments` map cannot.
 */
interface HostHolder {
  readonly providerSessionId: string;
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly lastActivityMs: number;
}

interface PreviewAutomationRequestErrorContext {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly providerSessionId: string;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly clientId: string;
  readonly connectionId: ClientConnection["connectionId"];
  readonly requestId: string;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs: number;
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly assignments: ReadonlyMap<string, HostAssignment>;
  readonly holders: ReadonlyMap<ClientConnection["environmentId"], HostHolder>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

type InvokeRoute =
  | { readonly type: "no-host" }
  | { readonly type: "busy"; readonly holder: HostHolder }
  | {
      readonly type: "route";
      readonly connection: ClientConnection;
      readonly requestId: string;
      readonly requestContext: PreviewAutomationRequestErrorContext;
      readonly requestSequence: number;
    };

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const holders = new Map(current.holders);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];
  const removedConnection = current.clients.get(clientId);
  if (removedConnection?.queue === queue) clients.delete(clientId);
  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }
  // Drop the exclusive-use lease once an environment has no connected host
  // left: nothing remains to hold the surface, and a stale holder would
  // otherwise wrongly block the next session until the idle window elapsed.
  if (removedConnection) {
    const environmentId = removedConnection.environmentId;
    const environmentStillConnected = Array.from(clients.values()).some(
      (connection) => connection.environmentId === environmentId,
    );
    if (!environmentStillConnected) holders.delete(environmentId);
  }
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  return {
    state: { ...current, clients, assignments, holders, pending },
    disconnected,
  };
};

const selectorDiagnosticsFromInput = (
  input: unknown,
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (typeof input !== "object" || input === null) return {};
  if ("locator" in input && typeof input.locator === "string") {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }
  if ("selector" in input && typeof input.selector === "string") {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }
  return {};
};

const hostAssignmentKey = (scope: McpInvocationContext.McpInvocationScope): string =>
  `${scope.environmentId}\u0000${scope.providerSessionId}`;

/**
 * Operations that actively drive the shared browser surface (input, navigation,
 * lifecycle) and must not interleave between provider sessions. Passive reads
 * (`status`, `snapshot`, `waitFor`) are omitted: they neither mutate the page
 * nor steal focus, so they run concurrently and never claim the lease.
 */
const PREVIEW_AUTOMATION_EXCLUSIVE_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "open",
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "setColorScheme",
  "close",
  "autofill",
  "recordingStart",
  "recordingStop",
]);

/**
 * How long the shared browser stays leased to its last active driver after that
 * driver goes quiet. A live multi-step interaction refreshes the lease on every
 * step, so this only elapses once a session truly stops touching the browser —
 * at which point another session (or a crashed holder's successor) may take over.
 */
const PREVIEW_AUTOMATION_LEASE_IDLE_MS = 10_000;

const isExclusiveOperation = (operation: PreviewAutomationOperation): boolean =>
  PREVIEW_AUTOMATION_EXCLUSIVE_OPERATIONS.has(operation);

const isPreviewTabId = Schema.is(PreviewTabId);

const readResultTabId = (result: unknown): PreviewTabId | null | undefined => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return undefined;
  const tabId = result.tabId;
  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function remoteDetailKind(detail: unknown): RemoteDetailKind {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };
  switch (error._tag) {
    case "PreviewAutomationRecordingDesktopUpdateRequiredError":
      return new PreviewAutomationRecordingDesktopUpdateRequiredError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingTooLargeError":
      return new PreviewAutomationRecordingTooLargeError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingDeadlineExpiredError":
      return new PreviewAutomationRecordingDeadlineExpiredError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingTransferError":
      return new PreviewAutomationRecordingTransferError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationNoAvailableHostError":
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationInvalidSelectorError": {
      return new PreviewAutomationInvalidSelectorError({
        ...context,
        ...remoteDiagnostics,
      });
    }
    case "PreviewAutomationTargetNotEditableError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteSelectorKind =
        detail &&
        "selectorKind" in detail &&
        (detail.selectorKind === "focused-element" ||
          detail.selectorKind === "locator" ||
          detail.selectorKind === "selector")
          ? detail.selectorKind
          : undefined;
      const remoteSelectorLength =
        detail &&
        "selectorLength" in detail &&
        typeof detail.selectorLength === "number" &&
        Number.isInteger(detail.selectorLength) &&
        detail.selectorLength >= 0
          ? detail.selectorLength
          : undefined;
      return new PreviewAutomationTargetNotEditableError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteSelectorKind === undefined && context.selectorKind === undefined
          ? {}
          : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
        ...(remoteSelectorLength === undefined && context.selectorLength === undefined
          ? {}
          : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const maximumBytes =
        detail &&
        "maximumBytes" in detail &&
        typeof detail.maximumBytes === "number" &&
        Number.isInteger(detail.maximumBytes) &&
        detail.maximumBytes > 0
          ? detail.maximumBytes
          : undefined;
      return new PreviewAutomationResultTooLargeError({
        ...context,
        ...remoteDiagnostics,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    default:
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
      });
  }
};

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    holders: new Map(),
    pending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);
      return [removed.disconnected, removed.state] as const;
    });
    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);
      const removed = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [] };
      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);
      return [
        {
          previousConnection,
          disconnected: removed.disconnected,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }
    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    yield* SynchronizedRef.update(state, (current) => {
      const currentHost = current.clients.get(host.clientId);
      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return current;
      }
      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
      });
      return { ...current, clients, focusSequence };
    });
  });

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
      const next = new Map(current.pending);
      next.delete(response.requestId);
      return [entry, { ...current, pending: next }] as const;
    });
    if (!pending) return;
    if (response.ok) {
      yield* Deferred.succeed(pending.deferred, response.result);
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    // Read the clock outside `modify` (its reducer must stay pure): the lease
    // guard below compares the current holder's last activity against `now`.
    const now = yield* Clock.currentTimeMillis;
    const exclusive = isExclusiveOperation(input.operation);
    const route = yield* SynchronizedRef.modify(
      state,
      (current): readonly [InvokeRoute, BrokerState] => {
        const assignments = new Map(
          Array.from(current.assignments).filter(([, assignment]) => {
            const connection = current.clients.get(assignment.clientId);
            return (
              connection?.connectionId === assignment.connectionId &&
              connection.queue === assignment.queue
            );
          }),
        );
        const assignmentKey = hostAssignmentKey(input.scope);
        const assigned = assignments.get(assignmentKey);
        const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
        const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
        // Keep one provider session on one physical desktop runtime so a
        // multi-step browser interaction cannot jump between independent
        // Electron cookie/DOM state. A live assignment that predates an
        // operation is not silently moved to a newer client: the caller gets a
        // capability failure and can deliberately start a fresh provider
        // session. A dead lease is pruned above and may fail over.
        const connection =
          hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
            ? assignedConnection
            : hasLiveAssignment
              ? undefined
              : Array.from(current.clients.values())
                  .filter(
                    (host) =>
                      host.environmentId === input.scope.environmentId &&
                      supportsOperation(host, input.operation),
                  )
                  .sort(
                    (left, right) =>
                      right.supportedOperations.size - left.supportedOperations.size ||
                      Number(right.focused) - Number(left.focused) ||
                      right.focusOrder - left.focusOrder,
                  )[0];
        if (!connection) {
          if (!hasLiveAssignment) assignments.delete(assignmentKey);
          return [{ type: "no-host" as const }, { ...current, assignments }] as const;
        }
        // Exclusive-use guard: while one provider session is actively driving the
        // shared browser for this environment, refuse a competing session's
        // interaction instead of stomping the surface the holder — and the human
        // watching it — is mid-flow with. Passive reads skip this entirely.
        if (exclusive) {
          const holder = current.holders.get(input.scope.environmentId);
          const holderActive =
            holder !== undefined && now - holder.lastActivityMs < PREVIEW_AUTOMATION_LEASE_IDLE_MS;
          if (holderActive && holder.providerSessionId !== input.scope.providerSessionId) {
            return [
              { type: "busy" as const, holder },
              { ...current, assignments },
            ] as const;
          }
        }
        const canReuseAssignedTab =
          assigned !== undefined &&
          assigned.connectionId === connection.connectionId &&
          assigned.queue === connection.queue;
        assignments.set(assignmentKey, {
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          queue: connection.queue,
          ...(canReuseAssignedTab && assigned.tabId !== undefined ? { tabId: assigned.tabId } : {}),
          ...(canReuseAssignedTab && assigned.tabSequence !== undefined
            ? { tabSequence: assigned.tabSequence }
            : {}),
        });

        const requestSequence = current.requestSequence;
        const requestId = `preview-${requestSequence}`;
        const tabId = input.tabId ?? (canReuseAssignedTab ? assigned.tabId : undefined);
        const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);
        const context: PreviewAutomationRequestErrorContext = {
          operation: input.operation,
          environmentId: input.scope.environmentId,
          threadId: input.scope.threadId,
          providerSessionId: input.scope.providerSessionId,
          providerInstanceId: input.scope.providerInstanceId,
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          requestId,
          ...(tabId === undefined ? {} : { tabId }),
          timeoutMs,
          ...selectorDiagnostics,
        };
        const pending = new Map(current.pending);
        pending.set(requestId, { queue: connection.queue, deferred, context });
        // Claim or refresh the exclusive lease so this session's next step (and
        // the idle timer) start from now. Passive reads leave the lease untouched.
        const holders = exclusive
          ? new Map(current.holders).set(input.scope.environmentId, {
              providerSessionId: input.scope.providerSessionId,
              threadId: input.scope.threadId,
              lastActivityMs: now,
            })
          : current.holders;
        return [
          {
            type: "route" as const,
            connection,
            requestId,
            requestContext: context,
            requestSequence,
          },
          {
            ...current,
            assignments,
            holders,
            pending,
            requestSequence: current.requestSequence + 1,
          },
        ] as const;
      },
    );
    if (route.type === "no-host") {
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
      });
    }
    if (route.type === "busy") {
      return yield* new PreviewAutomationBusyError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        holderProviderSessionId: route.holder.providerSessionId,
        ...(route.holder.threadId === undefined ? {} : { holderThreadId: route.holder.threadId }),
      });
    }
    const { connection, requestId, requestContext, requestSequence } = route;
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        type: "request",
        connectionId: connection.connectionId,
        request: {
          requestId,
          threadId: input.scope.threadId,
          tabId: requestContext.tabId,
          tabIdExplicit: input.tabId !== undefined,
          operation: input.operation,
          input: input.input,
          timeoutMs,
        },
      });
      if (!offered) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) {
          return (yield* completion.value) as A;
        }
        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
    const responseTabId = readResultTabId(result);
    const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;
    if (resultTabId === undefined) return result;
    const assignmentKey = hostAssignmentKey(input.scope);
    yield* SynchronizedRef.update(state, (current) => {
      const assignment = current.assignments.get(assignmentKey);
      if (
        !assignment ||
        assignment.connectionId !== connection.connectionId ||
        assignment.queue !== connection.queue ||
        (assignment.tabSequence ?? -1) > requestSequence
      ) {
        return current;
      }
      const assignments = new Map(current.assignments);
      if (resultTabId === null) {
        const { tabId: _tabId, ...withoutTabId } = assignment;
        assignments.set(assignmentKey, { ...withoutTabId, tabSequence: requestSequence });
      } else {
        assignments.set(assignmentKey, {
          ...assignment,
          ...(resultTabId === undefined ? {} : { tabId: resultTabId }),
          tabSequence: requestSequence,
        });
      }
      return { ...current, assignments };
    });
    return result;
  });

  return PreviewAutomationBroker.of({ connect, focusHost, respond, invoke });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);
