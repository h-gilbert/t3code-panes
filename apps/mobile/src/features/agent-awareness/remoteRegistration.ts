import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import type { SavedRemoteConnection } from "../../lib/connection";
import { runtime } from "../../lib/runtime";
import * as MobileStorage from "../../persistence/mobile-storage";
import { clearAgentAwarenessRegistrationRecord } from "../../persistence/imperative";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { isSelfHostedMobileBuild, supportsAgentAwarenessPush } from "./capabilities";
import { registerDirectNotificationDevice } from "./directRegistration";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "read-device-registration-relay-token",
  "read-device-unregistration-relay-token",
  "load-device-registration-identifier",
  "load-device-unregistration-identifier",
  "load-registration-record",
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

export type AgentAwarenessRegistrationError =
  | AgentAwarenessOperationError
  | ManagedRelay.ManagedRelayClientError;

export type AgentAwarenessRegistrationServices =
  | ManagedRelay.ManagedRelayClient
  | MobileStorage.MobileStorage;

let lastNativePushToken: string | null = null;
let registeredWithPushToken = false;
let nativePushTokenRotations = 0;
const environmentConnections = new Map<EnvironmentId, SavedRemoteConnection>();
let directNotificationPermissionRequested = false;
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(
  next: AgentAwarenessRegistrationStatus,
  withPushToken = registeredWithPushToken,
): void {
  if (registrationStatus === next && registeredWithPushToken === withPushToken) {
    return;
  }
  registrationStatus = next;
  registeredWithPushToken = withPushToken;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

export function agentAwarenessNotificationsReady(): boolean {
  return registrationStatus === "registered" && registeredWithPushToken;
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
  readonly directConnectionsChanged?: true;
}

export function normalizeAgentAwarenessRelayBaseUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    return null;
  }

  return { url: relayUrl };
}

function canRegisterPushNotifications(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

function shouldRegisterAgentAwarenessDeviceForProvider(
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
    // An unset JS identity may mean remount; native configure checks the persisted account on cold start.
    if (relayTokenProviderIdentity && identity !== relayTokenProviderIdentity) {
      clearAndroidAgentNotifications();
    }
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
  }
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    if (isSelfHostedMobileBuild()) {
      ensurePushTokenListener();
      ensureAppStateListener();
      enqueueDeviceRegistration({}, "direct device registration after startup failed");
      return;
    }
    clearAndroidAgentNotifications();
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    setRegistrationStatus("unknown");
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  if (isExistingIdentity) {
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Provider remounts retain a valid relay registration.
export function releaseAgentAwarenessRelayTokenProvider(): void {
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

const nativePushTokenRegistration = Effect.fn("remoteRegistration.nativePushTokenRegistration")(
  function* (observedPushToken?: string) {
    if (!canRegisterPushNotifications() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    // Android FCM data delivery is independent of notification presentation permission.
    if (!permissions.granted && Platform.OS !== "android") {
      return { notificationsEnabled: false, pushToken: null };
    }
    const alertsEnabled =
      permissions.granted &&
      (Platform.OS === "android" && Number(Platform.Version) >= 26
        ? yield* Effect.tryPromise({
            try: () => Notifications.getNotificationChannelAsync("agent-alerts"),
            catch: (cause) =>
              new AgentAwarenessOperationError({
                operation: "read-notification-permissions",
                cause,
              }),
          }).pipe(
            Effect.map((channel) => channel?.importance !== Notifications.AndroidImportance.NONE),
            Effect.orElseSucceed(() => false),
          )
        : true);
    if (observedPushToken) {
      lastNativePushToken = observedPushToken;
      nativePushTokenRotations++;
      return {
        notificationsEnabled: alertsEnabled,
        pushToken: observedPushToken,
      };
    }
    const rotationsBeforeLookup = nativePushTokenRotations;
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
          logRegistrationError("native push token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const lookedUpPushToken =
      token?.type === Platform.OS && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    // A rotation observed while this lookup ran is newer than what the lookup returned.
    if (lookedUpPushToken && rotationsBeforeLookup === nativePushTokenRotations) {
      lastNativePushToken = lookedUpPushToken;
    }
    const pushToken = lastNativePushToken;
    // A missing token must not disable notifications the relay accepted.
    return {
      notificationsEnabled: alertsEnabled,
      pushToken,
    };
  },
);

const relayToken = Effect.fn("remoteRegistration.relayToken")(function* (
  operation: "read-device-registration-relay-token",
) {
  const provider = relayTokenProvider;
  if (!provider) {
    return null;
  }
  return yield* Effect.tryPromise({
    try: provider,
    catch: (cause) => new AgentAwarenessOperationError({ operation, cause }),
  });
});

function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnIosCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

const registerDeviceWithRelay = Effect.fn("remoteRegistration.registerDeviceWithRelay")(function* (
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.fn.Return<void, AgentAwarenessRegistrationError, AgentAwarenessRegistrationServices> {
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    setRegistrationStatus("unknown");
    return;
  }
  const token = yield* relayToken("read-device-registration-relay-token");
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  if (!token) {
    setRegistrationStatus("unknown");
    return;
  }

  const identity = relayTokenProviderIdentity ?? "";
  const storage = yield* MobileStorage.MobileStorage;
  const persisted = yield* storage.loadAgentAwarenessRegistrationRecord.pipe(
    Effect.mapError(
      (cause) => new AgentAwarenessOperationError({ operation: "load-registration-record", cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the record loaded — do not resurrect the cleared
    // record or report the previous account's registration as current.
    return;
  }
  const payload = body;
  const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
  if (persisted?.identity === identity && persisted.signature === signature) {
    setRegistrationStatus("registered", Boolean(payload.pushToken));
    return;
  }

  const client = yield* ManagedRelay.ManagedRelayClient;
  yield* client.registerDevice({
    clerkToken: token,
    payload,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the request was in flight: the sign-out path already
    // reset the status and cleared the record for the next account, so a
    // stale success must not overwrite either.
    return;
  }
  setRegistrationStatus("registered", Boolean(payload.pushToken));
  yield* storage.saveAgentAwarenessRegistrationRecord({ identity, signature }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("persist registration record failed", error);
      }),
    ),
  );
});

const unregisterDeviceWithRelay = Effect.fn("remoteRegistration.unregisterDeviceWithRelay")(
  function* (input: {
    readonly deviceId: string;
    readonly tokenProvider: () => Promise<string | null>;
  }): Effect.fn.Return<void, AgentAwarenessRegistrationError, ManagedRelay.ManagedRelayClient> {
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
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  },
);

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

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return {
    ...(observedPushToken ? { observedPushToken } : {}),
    ...(current.directConnectionsChanged || next.directConnectionsChanged
      ? { directConnectionsChanged: true }
      : {}),
  };
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.directConnectionsChanged === true ||
    (next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken)
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
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
      // Refresh failures leave the relay's accepted registration intact; preserve registered status.
      // A sign-out or account switch meanwhile owns the status, so an obsolete run leaves it alone.
      if (generation === deviceRegistrationGeneration && registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
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
    return;
  }

  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: DeviceRegistrationInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, AgentAwarenessRegistrationError, AgentAwarenessRegistrationServices> {
  if (!canRegisterPushNotifications()) {
    return;
  }

  const storage = yield* MobileStorage.MobileStorage;
  const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
    Effect.mapError(
      (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-identifier",
          cause,
        }),
    ),
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  if (relayTokenProvider && relayTokenProviderIdentity) {
    configureAndroidAgentNotifications(deviceId, relayTokenProviderIdentity, false);
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  const body = makeRelayDeviceRegistrationRequest({
    deviceId,
    label:
      Constants.deviceName?.trim() ||
      // oxlint-disable-next-line t3code/no-untranslated-copy -- device label stored on the relay and shown to every client
      (Platform.OS === "android" ? "Android device" : "iOS device"),
    ...(Platform.OS === "android"
      ? {
          platform: "android" as const,
          androidApiLevel: Number(Platform.Version),
        }
      : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
    appVersion: Constants.expoConfig?.version,
    ...(bundleId ? { bundleId } : {}),
    ...(Platform.OS === "ios"
      ? {
          apsEnvironment: isSelfHostedMobileBuild()
            ? Constants.expoConfig?.extra?.selfHostedApnsEnvironment === "production"
              ? "production"
              : "sandbox"
            : resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
        }
      : {}),
    ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
    notificationsEnabled: pushTokenRegistration.notificationsEnabled,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  if (!isSelfHostedMobileBuild()) {
    yield* registerDeviceWithRelay(body, expectedGeneration);
    return;
  }
  const directResults = yield* Effect.forEach(
    [...environmentConnections.values()],
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
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  setRegistrationStatus(
    directResults.some(Boolean) ? "registered" : "unknown",
    Boolean(body.pushToken),
  );
});

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterPushNotifications()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (
      token.type === Platform.OS &&
      typeof token.data === "string" &&
      token.data.trim().length > 0
    ) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native push token rotation registration failed",
      );
    }
  });
}

function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterPushNotifications()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      return;
    }
    enqueueDeviceRegistration({}, "device registration after app foreground failed");
  });
}

export function registerAgentAwarenessConnection(connection: SavedRemoteConnection): void {
  if (
    !isSelfHostedMobileBuild() ||
    Platform.OS !== "ios" ||
    !connection.bearerToken ||
    connection.relayManaged === true
  ) {
    return;
  }

  environmentConnections.set(connection.environmentId, connection);
  ensurePushTokenListener();
  if (!directNotificationPermissionRequested) {
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
      enqueueDeviceRegistration(
        { directConnectionsChanged: true },
        "device registration after notification permission failed",
      );
    })();
  } else {
    enqueueDeviceRegistration({ directConnectionsChanged: true }, "device registration failed");
  }
}

export function unregisterAgentAwarenessConnection(environmentId: EnvironmentId): void {
  if (environmentConnections.delete(environmentId)) {
    enqueueDeviceRegistration({ directConnectionsChanged: true }, "direct connections changed");
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  AgentAwarenessRegistrationServices
> {
  return Effect.suspend(() => {
    const generation = deviceRegistrationGeneration;
    return registerDevice(undefined, generation).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (generation === deviceRegistrationGeneration && registrationStatus !== "registered") {
            setRegistrationStatus("failed");
          }
          logRegistrationError("device registration refresh failed", error);
        }),
      ),
    );
  });
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  registeredWithPushToken = false;
  lastNativePushToken = null;
  nativePushTokenRotations = 0;
  registrationStatusListeners.clear();
  directNotificationPermissionRequested = false;
  environmentConnections.clear();
}

export const unregisterAgentAwarenessDeviceForCurrentUser: (
  tokenProvider: () => Promise<string | null>,
) => Effect.Effect<void, never, AgentAwarenessRegistrationServices> = Effect.fn(
  "remoteRegistration.unregisterAgentAwarenessDeviceForCurrentUser",
)(
  function* (tokenProvider: () => Promise<string | null>) {
    const storage = yield* MobileStorage.MobileStorage;
    const deviceId = yield* storage.loadAgentAwarenessDeviceId.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-unregistration-identifier",
            cause,
          }),
      ),
    );
    if (!deviceId) {
      return;
    }
    yield* unregisterDeviceWithRelay({ deviceId, tokenProvider });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("device unregistration failed", error);
    }),
  ),
);
