/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { Cookies, FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { SavedRemoteConnection } from "../../lib/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Dpop from "../cloud/dpop";
import * as ManagedRelayLayer from "../cloud/managedRelayLayer";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import { MobileSecureStorageError } from "../../persistence/mobile-secure-storage";
import * as MobileStorage from "../../persistence/mobile-storage";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  agentAwarenessNotificationsReady,
  getAgentAwarenessRegistrationStatus,
  normalizeAgentAwarenessRelayBaseUrl,
  registerAgentAwarenessConnection,
  unregisterAgentAwarenessConnection,
  refreshAgentAwarenessRegistration,
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  subscribeAgentAwarenessRegistrationStatus,
  type AgentAwarenessRegistrationError,
  type AgentAwarenessRegistrationServices,
} from "./remoteRegistration";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { configureAndroidAgentNotifications } from "./androidNotifications";

vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: vi.fn(() => true),
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
}));

const registerDirectDevice = vi.hoisted(() =>
  vi.fn((_input: unknown) => Effect.succeed({ ok: true })),
);
vi.mock("./directRegistration", () => ({ registerDirectNotificationDevice: registerDirectDevice }));

const secureStore = vi.hoisted(() => new Map<string, string>());
const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
}));
const appStateMock = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
}));
const registrationRecordStore = vi.hoisted(() => ({
  current: null as {
    readonly identity: string;
    readonly signature: string;
  } | null,
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "1.0.0",
      extra: {},
    },
  },
}));

vi.mock("expo-notifications", () => ({
  AndroidImportance: { NONE: 0, HIGH: 4 },
  getNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: {
    SHA1: "SHA-1",
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
  },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError("expo-crypto digest data must be a typed array."));
    }
    return Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
    );
  },
}));

vi.mock("expo", async () => {
  const { createNodeDpopKeysModule } = await import("../cloud/dpop.testing");
  const dpopKeys = createNodeDpopKeysModule();
  return { requireNativeModule: () => dpopKeys };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return "ios";
    },
    get Version() {
      return "18.0";
    },
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMock.listeners.push(listener);
      return {
        remove: () => {
          const index = appStateMock.listeners.indexOf(listener);
          if (index >= 0) {
            appStateMock.listeners.splice(index, 1);
          }
        },
      };
    },
  },
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: unknown) =>
      new Promise((resolve) => {
        backgroundRuntime.pending.push({ operation, resolve });
      }),
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadAgentAwarenessRegistrationRecord: vi.fn(() =>
    Promise.resolve(registrationRecordStore.current),
  ),
  saveAgentAwarenessRegistrationRecord: vi.fn((record: { identity: string; signature: string }) => {
    registrationRecordStore.current = record;
    return Promise.resolve();
  }),
  clearAgentAwarenessRegistrationRecord: vi.fn(() => {
    registrationRecordStore.current = null;
    return Promise.resolve();
  }),
}));

function proofIat(proof: string): number {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iat: number;
  };
  return decoded.iat;
}

const storageFailure = (cause: unknown) =>
  new MobileSecureStorageError({ operation: "read", key: "test", cause });
const unexpectedStorage = () => Effect.die("Unexpected storage request");

// Delegates to the persistence/imperative mocks so each test steers both paths the same way.
const layerPersistenceTest = Layer.succeed(
  MobileStorage.MobileStorage,
  MobileStorage.MobileStorage.of({
    loadOrCreateAgentAwarenessDeviceId: Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: storageFailure,
    }),
    loadAgentAwarenessDeviceId: Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: storageFailure,
    }),
    loadAgentAwarenessRegistrationRecord: Effect.tryPromise({
      try: () => loadAgentAwarenessRegistrationRecord(),
      catch: storageFailure,
    }),
    saveAgentAwarenessRegistrationRecord: (record) =>
      Effect.tryPromise({
        try: () => saveAgentAwarenessRegistrationRecord(record),
        catch: storageFailure,
      }),
    clearAgentAwarenessRegistrationRecord: unexpectedStorage(),
    loadRecentThreadShortcuts: unexpectedStorage(),
    saveRecentThreadShortcuts: unexpectedStorage,
  }),
);

function savedConnection(): SavedRemoteConnection {
  return {
    environmentId: "env-1" as EnvironmentId,
    environmentLabel: "Desktop",
    pairingUrl: "https://desktop.example/pair",
    displayUrl: "https://desktop.example",
    httpBaseUrl: "https://desktop.example",
    wsBaseUrl: "wss://desktop.example/ws",
    bearerToken: "bearer-token",
  };
}

const layerRelayTest = ManagedRelayLayer.layer("https://relay.example.test").pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Dpop.layer)),
  Layer.merge(layerPersistenceTest),
);

const runBackgroundOperations = Effect.fn("TestRemoteRegistration.runBackgroundOperations")(
  function* () {
    let idlePasses = 0;
    const failures: Cause.Cause<AgentAwarenessRegistrationError>[] = [];
    // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- This harness drains mocked runtime jobs and their promise continuations, not external I/O or elapsed time.
    for (;;) {
      yield* Effect.promise(() => Promise.resolve());
      const pending = backgroundRuntime.pending.shift();
      if (!pending) {
        idlePasses++;
        if (idlePasses >= 3) {
          return failures;
        }
        continue;
      }
      idlePasses = 0;
      const exit = yield* Effect.exit(
        pending.operation as Effect.Effect<
          unknown,
          AgentAwarenessRegistrationError,
          AgentAwarenessRegistrationServices
        >,
      );
      if (Exit.isFailure(exit)) failures.push(exit.cause);
      yield* Effect.sync(() => {
        pending.resolve(exit);
      });
    }
  },
);

describe("makeRelayDeviceRegistrationRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "ios",
      data: "apns-token",
    });
    vi.mocked(Notifications.getPermissionsAsync).mockReset();
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: true,
    } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
    vi.mocked(Notifications.getNotificationChannelAsync).mockResolvedValue(null);
    vi.unstubAllGlobals();
    vi.stubGlobal("__DEV__", false);
    secureStore.clear();
    registerDirectDevice.mockClear();
    backgroundRuntime.pending.length = 0;
    Constants.expoConfig!.extra = {};
    __resetAgentAwarenessRemoteRegistrationForTest();
    appStateMock.listeners.length = 0;
    registrationRecordStore.current = null;
    vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(clearAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockResolvedValue("device-1");
  });

  it("keeps only approval, input and failure alerts in iOS registrations", () => {
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToken: "apns-token",
        notificationsEnabled: true,
      }),
    ).toEqual({
      deviceId: "device-1",
      label: "Julius's iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      pushToken: "apns-token",
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: false,
        notifyOnIosCompletion: false,
        notifyOnFailure: true,
      },
    });
  });

  it("registers the app's APNs routing so the relay targets the right bundle", () => {
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        bundleId: "com.t3tools.t3code.preview",
        apsEnvironment: resolveApsEnvironment("preview"),
        notificationsEnabled: true,
      }),
    ).toMatchObject({
      bundleId: "com.t3tools.t3code.preview",
      apsEnvironment: "production",
    });
  });

  it("routes development builds to the APNs sandbox", () => {
    expect(resolveApsEnvironment("development")).toBe("sandbox");
    expect(resolveApsEnvironment("preview")).toBe("production");
    expect(resolveApsEnvironment("production")).toBe("production");
    expect(resolveApsEnvironment(undefined)).toBe("production");
  });

  it("marks notification delivery disabled when self-hosted APNs permission is unavailable", () => {
    Constants.expoConfig!.extra = { selfHostedBuild: true };
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        notificationsEnabled: false,
      }),
    ).toEqual({
      deviceId: "device-1",
      label: "Julius's iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: false,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: false,
        notifyOnIosCompletion: false,
        notifyOnFailure: true,
      },
    });
  });

  it("normalizes relay base URLs for APNs registration requests", () => {
    expect(normalizeAgentAwarenessRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeAgentAwarenessRelayBaseUrl("   ")).toBeNull();
  });

  it.effect("registers self-hosted APNs with the current paired connection", () =>
    Effect.gen(function* () {
      Constants.expoConfig!.extra = {
        selfHostedBuild: true,
        selfHostedApnsEnvironment: "production",
      };

      const connection = savedConnection();

      registerAgentAwarenessConnection(connection);
      yield* runBackgroundOperations();

      expect(registerDirectDevice).toHaveBeenCalledExactlyOnceWith({
        connection,
        payload: expect.objectContaining({
          apsEnvironment: "production",
          pushToken: "apns-token",
          preferences: expect.objectContaining({
            notificationsEnabled: true,
            liveActivitiesEnabled: false,
            notifyOnCompletion: false,
            notifyOnIosCompletion: false,
          }),
        }),
      });
      expect(agentAwarenessNotificationsReady()).toBe(true);

      unregisterAgentAwarenessConnection(connection.environmentId);
      yield* runBackgroundOperations();
      expect(registerDirectDevice).toHaveBeenCalledTimes(1);
      expect(agentAwarenessNotificationsReady()).toBe(false);
    }).pipe(Effect.provide(layerRelayTest)),
  );

  it("disables push features in Personal Team relay registrations", () => {
    Constants.expoConfig!.extra = { iosPersonalTeamBuild: true };

    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToken: "apns-token",

        notificationsEnabled: true,
      }).preferences,
    ).toMatchObject({
      liveActivitiesEnabled: false,
      notificationsEnabled: false,
    });
  });

  it.effect("registers the APNs device when cloud auth becomes available", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      const requestUrl = (request: unknown) =>
        request instanceof Request ? request.url : String(request);
      const deviceCalls = fetchMock.mock.calls.filter(([request]) =>
        requestUrl(request).endsWith("/v1/mobile/devices"),
      );
      expect(deviceCalls).toHaveLength(1);
      const [request, init] = deviceCalls[0] as unknown as [unknown, RequestInit | undefined];
      const url = requestUrl(request);
      const method = request instanceof Request ? request.method : init?.method;
      const headers = request instanceof Request ? request.headers : new Headers(init?.headers);
      const dpop = headers.get("dpop");
      expect(url).toBe("https://relay.example.test/v1/mobile/devices");
      expect(method).toBe("POST");
      expect(headers.get("authorization")).toBe("DPoP relay-dpop-token");
      expect(dpop).toEqual(expect.any(String));
      if (!dpop) {
        throw new Error("Missing DPoP header.");
      }
      expect(
        verifyDpopProof({
          proof: dpop,
          method: "POST",
          url: "https://relay.example.test/v1/mobile/devices",
          expectedAccessToken: "relay-dpop-token",
          nowEpochSeconds: proofIat(dpop),
        }),
      ).toMatchObject({ ok: true });
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("marks registration failed when device registration cannot complete", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
      new Error("registration failed"),
    );
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it("stops foreground registration on cloud sign-out", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    expect(appStateMock.listeners).toHaveLength(1);
    setAgentAwarenessRelayTokenProvider(null);
    expect(appStateMock.listeners).toHaveLength(0);
  });

  it("clears registration status on cloud sign-out", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    setAgentAwarenessRelayTokenProvider(null);
    expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    expect(clearAgentAwarenessRegistrationRecord).toHaveBeenCalled();
  });

  it("releases the provider without clearing the registration", () => {
    registrationRecordStore.current = { identity: "", signature: "sig" };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    releaseAgentAwarenessRelayTokenProvider();

    expect(clearAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    expect(registrationRecordStore.current).not.toBeNull();
  });

  it.effect("resets a pending status to unknown when relay config is missing", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("re-registers when the stored account identity differs", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    registrationRecordStore.current = { identity: "someone-else", signature: "stale" };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(saveAgentAwarenessRegistrationRecord).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("coalesces simultaneous sign-in and environment connection registrations", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    vi.mocked(Notifications.getPermissionsAsync).mockClear();
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    registerAgentAwarenessConnection(savedConnection());

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect(
    "keeps the user-scoped relay APNs device when an environment connection is removed",
    () => {
      const fetchMock = vi.fn((request: RequestInfo | URL) => {
        const url = request instanceof Request ? request.url : String(request);
        return Promise.resolve(
          Response.json(
            url.endsWith("/v1/client/dpop-token")
              ? {
                  access_token: "relay-dpop-token",
                  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                  token_type: "DPoP",
                  expires_in: 300,
                  scope: "mobile:registration",
                }
              : { ok: true },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      Constants.expoConfig!.extra = {
        relay: {
          url: "https://relay.example.test/",
        },
      };

      registerAgentAwarenessConnection(savedConnection());
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        fetchMock.mockClear();

        unregisterAgentAwarenessConnection(savedConnection().environmentId);

        expect(fetchMock).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layerRelayTest));
    },
  );
  it.effect("keeps a registered status when a later refresh fails", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");

      vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
        new Error("transient failure"),
      );
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("leaves the signed-out status alone when an obsolete registration fails", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValue(new Error("storage failure"));
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    setAgentAwarenessRelayTokenProvider(null);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("does not re-register the same account when nothing has changed", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).toHaveBeenCalledTimes(1);
      expect(registrationRecordStore.current).not.toBeNull();

      vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("continues queued device registration after a failed auth lookup", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    // Sign-in first reads the widget snapshot, then registers the device; fail
    // both lookups so the queued registration is the one that must recover.
    const tokenProvider = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("auth unavailable"))
      .mockRejectedValueOnce(new Error("auth unavailable"))
      .mockResolvedValue("clerk-token-user-a");
    setAgentAwarenessRelayTokenProvider(tokenProvider);
    const tokenListener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
    expect(tokenListener).toBeDefined();
    tokenListener?.({ type: "ios", data: "rotated-apns-token" } as never);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(backgroundRuntime.pending).toHaveLength(0);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect.each(["ios", "android"] as const)(
    "does not enable %s notifications when a token rotates after permission is revoked",
    (os) => {
      vi.spyOn(Platform, "OS", "get").mockReturnValue(os);
      vi.spyOn(Platform, "Version", "get").mockReturnValue(os === "ios" ? 18 : 36);
      vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
        type: os,
        data: "initial",
      });
      const registrations: unknown[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/v1/client/dpop-token")) {
          return Response.json({
            access_token: "dpop",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          });
        }
        registrations.push(await request.json());
        return Response.json({ ok: true });
      });
      Constants.expoConfig!.extra = { relay: { url: "https://permission-relay.example.test" } };
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk"), "user-a");
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: false,
            notifyOnCompletion: false,
            notifyOnIosCompletion: false,
          },
        });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
          granted: false,
        } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
        listener({ type: os, data: "rotated" });
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          preferences: { notificationsEnabled: false, liveActivitiesEnabled: false },
        });
        if (os === "android") {
          expect(registrations.at(-1)).toMatchObject({ pushToken: "rotated" });
          vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
            granted: false,
          } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
          yield* refreshAgentAwarenessRegistration();
          expect(registrations.at(-1)).toMatchObject({
            pushToken: "initial",
            preferences: { notificationsEnabled: false, liveActivitiesEnabled: false },
          });
        } else {
          expect(registrations.at(-1)).not.toHaveProperty("pushToken");
        }
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provide(
          ManagedRelayLayer.layer("https://permission-relay.example.test").pipe(
            Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Dpop.layer)),
            Layer.merge(layerPersistenceTest),
          ),
        ),
      );
    },
  );

  const stubAndroidDeviceRelay = () => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
    vi.spyOn(Platform, "Version", "get").mockReturnValue(36);
    const registrations: Array<{
      readonly preferences: { readonly notificationsEnabled: boolean };
    }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/client/dpop-token")) {
        return Response.json({
          access_token: "relay-dpop-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 300,
          scope: "mobile:registration",
        });
      }
      if (request.url.endsWith("/v1/mobile/devices")) {
        registrations.push(await request.json());
      }
      return Response.json({ ok: true });
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
    return registrations;
  };

  it.effect("does not report notifications ready when its push token lookup fails", () => {
    const registrations = stubAndroidDeviceRelay();
    vi.mocked(Notifications.getDevicePushTokenAsync).mockRejectedValue(
      new Error("Default FirebaseApp is not initialized"),
    );
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      // Live Activities register with their own tokens, so the device stays registered.
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(agentAwarenessNotificationsReady()).toBe(false);
      expect(registrations).toMatchObject([{ preferences: { notificationsEnabled: true } }]);
      expect(registrations[0]).not.toHaveProperty("pushToken");

      const onStatusChange = vi.fn();
      subscribeAgentAwarenessRegistrationStatus(onStatusChange);
      const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
      listener({ type: "android", data: "fcm-token" } as never);
      yield* runBackgroundOperations();

      expect(agentAwarenessNotificationsReady()).toBe(true);
      expect(onStatusChange).toHaveBeenCalled();
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provide(layerRelayTest),
    );
  });

  it.effect("keeps notifications enabled when a refresh cannot read the push token", () => {
    const registrations = stubAndroidDeviceRelay();
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "android",
      data: "fcm-token",
    });
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(registrations).toMatchObject([{ preferences: { notificationsEnabled: true } }]);
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");

      vi.mocked(Notifications.getDevicePushTokenAsync).mockRejectedValueOnce(
        new Error("SERVICE_NOT_AVAILABLE"),
      );
      yield* refreshAgentAwarenessRegistration();

      expect(registrations).toMatchObject([{ preferences: { notificationsEnabled: true } }]);
      expect(agentAwarenessNotificationsReady()).toBe(true);

      // A lookup that started before a rotation must not replace the rotated token.
      let resolveStaleLookup: (token: { type: "android"; data: string }) => void = () => {};
      let markLookupStarted: () => void = () => {};
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      vi.mocked(Notifications.getDevicePushTokenAsync).mockImplementationOnce(() => {
        markLookupStarted();
        return new Promise((resolve) => {
          resolveStaleLookup = resolve;
        });
      });
      const staleRefresh = yield* Effect.forkChild(refreshAgentAwarenessRegistration());
      yield* Effect.promise(() => lookupStarted);
      const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
      listener({ type: "android", data: "rotated-fcm-token" } as never);
      yield* runBackgroundOperations();
      resolveStaleLookup({ type: "android", data: "fcm-token" });
      yield* Fiber.join(staleRefresh);
      vi.mocked(Notifications.getDevicePushTokenAsync).mockRejectedValueOnce(
        new Error("SERVICE_NOT_AVAILABLE"),
      );
      yield* refreshAgentAwarenessRegistration();

      expect(registrations.at(-1)).toMatchObject({ pushToken: "rotated-fcm-token" });
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provide(layerRelayTest),
    );
  });

  it.effect.each(["blocked", "unavailable"] as const)(
    "keeps Android push delivery registered when the alert channel is %s",
    (channelState) => {
      vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
      vi.spyOn(Platform, "Version", "get").mockReturnValue(36);
      vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
        type: "android",
        data: "fcm-token",
      });
      vi.mocked(Notifications.getNotificationChannelAsync).mockResolvedValue({
        id: "agent-alerts",
        name: "Agent alerts",
        importance: Notifications.AndroidImportance.NONE,
      } as Awaited<ReturnType<typeof Notifications.getNotificationChannelAsync>>);
      if (channelState === "unavailable") {
        vi.mocked(Notifications.getNotificationChannelAsync).mockRejectedValue(
          new Error("Android channel lookup failed"),
        );
      }
      const registrations: unknown[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/v1/client/dpop-token")) {
          return Response.json({
            access_token: "dpop",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          });
        }
        registrations.push(await request.json());
        return Response.json({ ok: true });
      });
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk"), "user-a");
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          pushToken: "fcm-token",
          preferences: { notificationsEnabled: false, liveActivitiesEnabled: false },
        });
        expect(getAgentAwarenessRegistrationStatus()).toBe("registered");

        const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
        listener({ type: "android", data: "rotated-fcm-token" });
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          pushToken: "rotated-fcm-token",
          preferences: { notificationsEnabled: false, liveActivitiesEnabled: false },
        });

        vi.mocked(Notifications.getNotificationChannelAsync).mockResolvedValue(null);
        yield* refreshAgentAwarenessRegistration();
        expect(registrations.at(-1)).toMatchObject({
          pushToken: "fcm-token",
          preferences: { notificationsEnabled: true },
        });
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provide(layerRelayTest),
      );
    },
  );
  it.effect("preserves relay rejection errors with React Native response headers", () => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "android",
      data: "fcm-token",
    });
    const rejectedResponse = new Response("Unsupported device platform", { status: 400 });
    Object.defineProperty(rejectedResponse.headers, "getSetCookie", { value: undefined });
    vi.stubGlobal("fetch", (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      const response = url.endsWith("/v1/client/dpop-token")
        ? Response.json({
            access_token: "relay-dpop-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          })
        : rejectedResponse;
      Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
      return Promise.resolve(response);
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");

    return Effect.gen(function* () {
      // Hermes' compiled error hashing reads the response's cookie getter.
      const httpResponse = HttpClientResponse.fromWeb(
        HttpClientRequest.post("https://relay.example.test/v1/mobile/devices"),
        rejectedResponse,
      );
      expect(httpResponse.cookies).toEqual(Cookies.empty);
      const failures = yield* runBackgroundOperations();
      expect(failures).toHaveLength(1);
      expect(Cause.hasDies(failures[0]!)).toBe(false);
      expect(Cause.squash(failures[0]!)).toBeInstanceOf(
        ManagedRelay.ManagedRelayRequestFailedError,
      );
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect(
    "does not reconfigure or register a detached Android account from an in-flight operation",
    () => {
      vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
      vi.spyOn(Platform, "Version", "get").mockReturnValue(36);
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token"), "user-a");
      releaseAgentAwarenessRelayTokenProvider();
      vi.mocked(configureAndroidAgentNotifications).mockClear();
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(configureAndroidAgentNotifications).not.toHaveBeenCalled();
        expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layerRelayTest));
    },
  );
});
