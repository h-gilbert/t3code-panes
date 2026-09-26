/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  Cookies,
  FetchHttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { EnvironmentId } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import type { SavedRemoteConnection } from "../../lib/connection";
import { cryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  getAgentAwarenessRegistrationStatus,
  normalizeAgentAwarenessRelayBaseUrl,
  refreshAgentAwarenessRegistration,
  registerAgentAwarenessConnection,
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  shouldRegisterAgentAwarenessDeviceForProvider,
  unregisterAgentAwarenessConnection,
} from "./remoteRegistration";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: vi.fn(() => false),
}));

const secureStore = vi.hoisted(() => new Map<string, string>());
const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
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
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
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

const relayTestLayer = managedRelayClientLayer("https://relay.example.test").pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
);

const runBackgroundOperations = Effect.fn("TestRemoteRegistration.runBackgroundOperations")(
  function* () {
    let idlePasses = 0;
    for (;;) {
      yield* Effect.promise(() => Promise.resolve());
      const pending = backgroundRuntime.pending.shift();
      if (!pending) {
        idlePasses++;
        if (idlePasses >= 3) {
          return;
        }
        continue;
      }
      idlePasses = 0;
      const exit = yield* Effect.exit(
        pending.operation as Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
      );
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
    vi.unstubAllGlobals();
    vi.stubGlobal("__DEV__", false);
    secureStore.clear();
    backgroundRuntime.pending.length = 0;
    Constants.expoConfig!.extra = {};
    __resetAgentAwarenessRemoteRegistrationForTest();
    registrationRecordStore.current = null;
    vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(clearAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockResolvedValue("device-1");
  });

  it("keeps notifications while disabling Live Activities in relay registrations", () => {
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
        notifyOnIosCompletion: true,
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

  it("marks notification delivery disabled when APNs permission is unavailable", () => {
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
        notifyOnIosCompletion: true,
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

  it.effect("refreshes APNs registration for connected environments after settings changes", () => {
    registerAgentAwarenessConnection(savedConnection());
    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();

      yield* refreshAgentAwarenessRegistration();

      expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
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

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [request, init] = fetchMock.mock.calls[1] as unknown as [
        unknown,
        RequestInit | undefined,
      ];
      const url = request instanceof Request ? request.url : String(request);
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
    }).pipe(Effect.provide(relayTestLayer));
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
      // Drive the registration directly so the assertion does not depend on the
      // background queue draining; refreshAgentAwarenessRegistration swallows the
      // error but must record the failed status so the settings toggles cannot
      // read as enabled.
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
    }).pipe(Effect.provide(relayTestLayer));
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
    // No relay url configured: registration can neither run nor ever succeed,
    // so the status must not stick at "pending".
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }).pipe(Effect.provide(relayTestLayer));
  });

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

      // The relay still holds the accepted registration; a transient refresh
      // failure must not flip the settings toggles off.
      vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
        new Error("transient failure"),
      );
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(relayTestLayer));
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

      // Second attempt with an identical payload must skip the relay entirely,
      // so no new registration record is written.
      vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(relayTestLayer));
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
    }).pipe(Effect.provide(relayTestLayer));
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
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("continues queued device registration after a failed auth lookup", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    const tokenProvider = vi
      .fn<() => Promise<string | null>>()
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
    }).pipe(Effect.provide(relayTestLayer));
  });

  it("only registers again when the authenticated identity changes", () => {
    expect(shouldRegisterAgentAwarenessDeviceForProvider(null, "user-a")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-a")).toBe(false);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-b")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", undefined)).toBe(true);
  });

  it.effect("registers rotated APNs tokens without rereading the native token", () => {
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

    vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    const tokenListener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
    expect(tokenListener).toBeDefined();
    tokenListener?.({ type: "ios", data: "rotated-apns-token" } as never);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
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
      }).pipe(Effect.provide(relayTestLayer));
    },
  );
  for (const os of ["ios"] as const) {
    it.effect(
      `does not enable ${os} notifications when a token rotates after permission is revoked`,
      () => {
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
            preferences: { notificationsEnabled: true },
          });
          vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
            granted: false,
          } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
          const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
          listener({ type: os, data: "rotated" });
          yield* runBackgroundOperations();
          expect(registrations.at(-1)).toMatchObject({
            preferences: { notificationsEnabled: false },
          });
          expect(registrations.at(-1)).not.toHaveProperty("pushToken");
        }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.provide(
            managedRelayClientLayer("https://permission-relay.example.test").pipe(
              Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
            ),
          ),
        );
      },
    );
  }
  it.effect("preserves relay rejection errors with React Native response headers", () => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue("ios");
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "ios",
      data: "apns-token",
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
    Constants.expoConfig!.extra = { relay: { url: "https://headers-relay.example.test" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");

    return Effect.gen(function* () {
      // Hermes' compiled error hashing reads the response's cookie getter.
      const httpResponse = HttpClientResponse.fromWeb(
        HttpClientRequest.post("https://headers-relay.example.test/v1/mobile/devices"),
        rejectedResponse,
      );
      expect(httpResponse.cookies).toEqual(Cookies.empty);
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        managedRelayClientLayer("https://headers-relay.example.test").pipe(
          Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  });
});
