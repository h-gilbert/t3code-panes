import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { type RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import type { SavedRemoteConnection } from "../../lib/connection";
import { runtime } from "../../lib/runtime";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import { registerDirectNotificationDevice } from "./directRegistration";

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "read-device-registration-relay-token",
  "read-device-unregistration-relay-token",
  "load-device-registration-identifier",
  "load-device-unregistration-identifier",
]);

export class AgentAwarenessOperationError extends Schema.TaggedError<AgentAwarenessOperationError>()(
  "AgentAwarenessOperationError",
  {
    operation: AgentAwarenessOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent awareness operation ${this.operation} failed.`;
  }
}

const environmentConnections = new Map<EnvironmentId, SavedRemoteConnection>();
let pushTokenSubscription: { remove: () => void } | null = null;
let directNotificationPermissionRequested = false;

// Whether the relay has actually accepted this device's registration. The
// notification setting reflects this rather than only local iOS permission. If
// the registration request never succeeded, the device cannot receive anything.
export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(next: AgentAwarenessRegistrationStatus): void {
  if (registrationStatus === next) {
    return;
  }
  registrationStatus = next;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void {
  registrationStatusListeners.add(listener);
  return () => {
    registrationStatusListeners.delete(listener);
  };
}
let relayTokenProvider: (() => Promise<string | null>) | null = null;
let relayTokenProviderIdentity: string | null = null;
let deviceRegistrationGeneration = 0;
let activeDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  operation: Promise<void>;
} | null = null;
let pendingDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  readonly context: string;
} | null = null;

interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    logRegistrationDebug("relay registration skipped; relay config missing");
    return null;
  }

  return { url: relayUrl };
}

function canRegisterAgentAwarenessDevice(): boolean {
  return Platform.OS === "ios";
}

function isSelfHostedBuild(): boolean {
  return Constants.expoConfig?.extra?.selfHostedBuild === true;
}

function directNotificationConnections(): ReadonlyArray<SavedRemoteConnection> {
  if (!isSelfHostedBuild()) return [];
  return [...environmentConnections.values()].filter(
    (connection) => connection.relayManaged !== true && connection.bearerToken !== null,
  );
}

export function shouldRegisterAgentAwarenessDeviceForProvider(
  previousIdentity: string | null,
  identity: string | undefined,
): boolean {
  return identity === undefined || identity !== previousIdentity;
}

export function setAgentAwarenessRelayTokenProvider(
  provider: (() => Promise<string | null>) | null,
  identity?: string,
): void {
  const isExistingIdentity =
    provider !== null &&
    !shouldRegisterAgentAwarenessDeviceForProvider(relayTokenProviderIdentity, identity);
  if (!isExistingIdentity) {
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
  }
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    if (isSelfHostedBuild()) {
      ensurePushTokenListener();
      enqueueDeviceRegistration({}, "direct device registration after startup failed");
      return;
    }
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    setRegistrationStatus("unknown");
    // Sign-out is the only thing that invalidates a stored registration, so the
    // next sign-in re-registers.
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  ensurePushTokenListener();
  if (isExistingIdentity) {
    // Same account re-activating (e.g. Clerk token refresh) normally needs no
    // re-registration — but if the previous attempt never succeeded, this is
    // the only trigger that will retry it before the next cold start.
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Detach the provider and native listener without the destructive sign-out
// cleanup. The relay still holds a valid registration and the next mount
// reuses it.
export function releaseAgentAwarenessRelayTokenProvider(): void {
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

function nativePushTokenRegistration(observedPushToken?: string) {
  return Effect.gen(function* () {
    if (!canRegisterAgentAwarenessDevice() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    if (observedPushToken) {
      return { notificationsEnabled: true, pushToken: observedPushToken };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    if (!permissions.granted) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-native-push-token",
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logRegistrationError("native APNs token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const pushToken =
      token?.type === "ios" && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    return { notificationsEnabled: pushToken !== null, pushToken };
  });
}

const relayToken = (operation: "read-device-registration-relay-token") =>
  Effect.gen(function* () {
    const provider = relayTokenProvider;
    if (!provider) {
      return null;
    }
    return yield* Effect.tryPromise({
      try: provider,
      catch: (cause) => new AgentAwarenessOperationError({ operation, cause }),
    });
  });

// Stable fingerprint of everything the relay stores for this device. When it
// matches the last accepted registration for the same account, re-registering
// is a no-op, so a launch that changed nothing skips the request entirely.
function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.iosMajorVersion,
    body.preferences.notificationsEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnIosCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

function registerDeviceWithRelay(
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (expectedGeneration !== deviceRegistrationGeneration) {
      logRegistrationDebug("device registration cancelled before relay request", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    const relayConfig = readRelayConfig();
    if (!relayConfig) {
      // Nothing is in flight and nothing can succeed until configuration
      // appears; "pending" would otherwise stick forever.
      setRegistrationStatus("unknown");
      return;
    }
    const token = yield* relayToken("read-device-registration-relay-token");
    if (expectedGeneration !== deviceRegistrationGeneration) {
      logRegistrationDebug("device registration cancelled after auth lookup", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    if (!token) {
      logRegistrationDebug("relay device registration skipped; user is not signed in");
      setRegistrationStatus("unknown");
      return;
    }

    // Skip the request when this account already registered an identical
    // payload; the relay upsert would be a no-op. The record is only cleared on
    // sign-out, so a device stays registered across launches without re-hitting
    // the relay every time the app opens.
    const identity = relayTokenProviderIdentity ?? "";
    const persisted = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessRegistrationRecord(),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null));
    if (expectedGeneration !== deviceRegistrationGeneration) {
      // Signed out while the record loaded — do not resurrect the cleared
      // record or report the previous account's registration as current.
      logRegistrationDebug("device registration cancelled after record lookup", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    const payload = body;
    // The relay URL participates so pointing the app at a different relay
    // invalidates the record and re-registers there.
    const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
    if (persisted && persisted.identity === identity && persisted.signature === signature) {
      setRegistrationStatus("registered");
      logRegistrationDebug("relay device registration skipped; already registered for account", {
        expectedGeneration,
      });
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    logRegistrationDebug("relay device registration request started", {
      expectedGeneration,
    });
    yield* client.registerDevice({
      clerkToken: token,
      payload,
    });
    if (expectedGeneration !== deviceRegistrationGeneration) {
      // Signed out while the request was in flight: the sign-out path already
      // reset the status and cleared the record for the next account, so a
      // stale success must not overwrite either.
      logRegistrationDebug("device registration completed after sign-out; result discarded", {
        expectedGeneration,
        currentGeneration: deviceRegistrationGeneration,
      });
      return;
    }
    setRegistrationStatus("registered");
    yield* Effect.promise(() =>
      saveAgentAwarenessRegistrationRecord({
        identity,
        signature,
      }).catch((error: unknown) => {
        logRegistrationError("persist registration record failed", error);
      }),
    );
    logRegistrationDebug("relay device registration request completed", {
      expectedGeneration,
    });
  });
}

function unregisterDeviceWithRelay(input: {
  readonly deviceId: string;
  readonly tokenProvider: () => Promise<string | null>;
}): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!readRelayConfig()) return;
    const token = yield* Effect.tryPromise({
      try: input.tokenProvider,
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-device-unregistration-relay-token",
          cause,
        }),
    });
    if (!token) {
      logRegistrationDebug("relay device unregistration skipped; user is not signed in");
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  });
}

function logRegistrationError(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    traceId: findErrorTraceId(error),
    error,
  });
}

function logRegistrationDebug(context: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.log(`[agent-awareness] ${context}`, details ?? "");
}

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return observedPushToken ? { observedPushToken } : {};
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
  logRegistrationDebug("device registration started", {
    generation,
    hasObservedPushToken: next.input.observedPushToken !== undefined,
  });
  if (registrationStatus !== "registered") {
    setRegistrationStatus("pending");
  }
  const registration = {
    input: next.input,
    operation: Promise.resolve(),
  };
  activeDeviceRegistration = registration;
  registration.operation = (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(registerDevice(next.input, generation)),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // A transient failure on a later refresh (e.g. token rotation) leaves
      // the prior accepted registration intact on the relay, so an already
      // registered device stays "registered" rather than flipping the
      // settings toggles off.
      if (registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
    logRegistrationDebug("device registration finished", { generation });
    if (activeDeviceRegistration === registration) {
      activeDeviceRegistration = null;
    }
    startPendingDeviceRegistration();
  })();
}

function enqueueDeviceRegistration(input: DeviceRegistrationInput, context: string): void {
  if (
    activeDeviceRegistration &&
    !registrationAddsInformation(activeDeviceRegistration.input, input)
  ) {
    logRegistrationDebug("device registration coalesced with active request", {
      generation: deviceRegistrationGeneration,
    });
    return;
  }

  logRegistrationDebug("device registration enqueued", {
    generation: deviceRegistrationGeneration,
    hasActiveRegistration: activeDeviceRegistration !== null,
    hasPendingRegistration: pendingDeviceRegistration !== null,
  });
  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

function registerDevice(
  input: DeviceRegistrationInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!canRegisterAgentAwarenessDevice()) {
      logRegistrationDebug("device registration skipped; platform does not support it");
      return;
    }

    logRegistrationDebug("device registration loading local state", { expectedGeneration });
    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-identifier",
          cause,
        }),
    });
    const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
    logRegistrationDebug("device registration local state ready", {
      expectedGeneration,
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
    });
    const bundleId = Constants.expoConfig?.ios?.bundleIdentifier?.trim();
    const body = makeRelayDeviceRegistrationRequest({
      deviceId,
      label: Constants.deviceName?.trim() || "iOS device",
      iosMajorVersion: iosMajorVersion(),
      appVersion: Constants.expoConfig?.version,
      ...(bundleId ? { bundleId } : {}),
      apsEnvironment: isSelfHostedBuild()
        ? Constants.expoConfig?.extra?.selfHostedApnsEnvironment === "production"
          ? "production"
          : "sandbox"
        : resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
      ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
    });
    const directResults = yield* Effect.forEach(
      directNotificationConnections(),
      (connection) =>
        registerDirectNotificationDevice({ connection, payload: body }).pipe(
          Effect.map((response) => response.ok),
          Effect.catch((error) =>
            Effect.sync(() => {
              logRegistrationError(
                `direct device registration failed for ${connection.environmentLabel}`,
                error,
              );
              return false;
            }),
          ),
        ),
      { concurrency: 4 },
    );
    if (directResults.some(Boolean)) {
      setRegistrationStatus("registered");
    }
    if (readRelayConfig() && relayTokenProvider) {
      yield* registerDeviceWithRelay(body, expectedGeneration);
    } else if (!directResults.some(Boolean)) {
      setRegistrationStatus("unknown");
    }
  });
}

function registerDeviceForCurrentUser(): Effect.Effect<
  void,
  unknown,
  ManagedRelay.ManagedRelayClient
> {
  return registerDevice(undefined);
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterAgentAwarenessDevice()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (token.type === "ios" && typeof token.data === "string" && token.data.trim().length > 0) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native APNs token rotation registration failed",
      );
    }
  });
}

export function registerAgentAwarenessConnection(connection: SavedRemoteConnection): void {
  if (!canRegisterAgentAwarenessDevice()) {
    return;
  }

  environmentConnections.set(connection.environmentId, connection);
  ensurePushTokenListener();
  if (
    isSelfHostedBuild() &&
    connection.relayManaged !== true &&
    connection.bearerToken !== null &&
    !directNotificationPermissionRequested
  ) {
    directNotificationPermissionRequested = true;
    void (async () => {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure" && !isAtomCommandInterrupted(permission)) {
        logRegistrationError(
          "direct notification permission request failed",
          squashAtomCommandFailure(permission),
        );
      }
      enqueueDeviceRegistration({}, "device registration after notification permission failed");
    })();
  } else {
    enqueueDeviceRegistration({}, "device registration failed");
  }
}

function removeAgentAwarenessConnection(environmentId: EnvironmentId): void {
  environmentConnections.delete(environmentId);
}

export function unregisterAgentAwarenessConnection(environmentId: EnvironmentId): void {
  removeAgentAwarenessConnection(environmentId);
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return registerDeviceForCurrentUser().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Same rationale as the queued path: a failed refresh does not undo an
        // already accepted registration.
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device registration refresh failed", error);
      }),
    ),
  );
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  environmentConnections.clear();
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  registrationStatusListeners.clear();
  directNotificationPermissionRequested = false;
}

export function unregisterAgentAwarenessDeviceForCurrentUser(
  tokenProvider: () => Promise<string | null>,
): Effect.Effect<void, never, ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    const deviceId = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-unregistration-identifier",
          cause,
        }),
    });
    if (!deviceId) {
      return;
    }
    yield* unregisterDeviceWithRelay({ deviceId, tokenProvider });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("device unregistration failed", error);
      }),
    ),
  );
}
