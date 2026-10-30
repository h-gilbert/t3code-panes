import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
/**
 * The server's implementation of `ProviderHost.ProviderHost`, the only server surface
 * provider drivers and adapters may use.
 *
 * @module provider/ProviderHostLive
 */
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const hostPower = yield* Effect.serviceOption(HostPowerMonitor.HostPowerMonitor);
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resumed: (Option.isSome(hostPower) ? hostPower.value.streamChanges : Stream.empty).pipe(
        Stream.map((snapshot) => snapshot.suspended),
        Stream.changes,
        Stream.filter((suspended) => !suspended),
        Stream.map(() => undefined),
      ),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      // DocumentText owns the path-resolution span.
      resolveExtractedTextPath: Effect.fnUntraced(
        function* (path) {
          return yield* DocumentText.resolveExtractedTextPath(path);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
      credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
        return ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Crypto.Crypto, crypto),
        );
      }),
    });
  }),
);
