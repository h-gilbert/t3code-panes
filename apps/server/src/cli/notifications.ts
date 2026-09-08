import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  APNS_BUNDLE_ID_SECRET,
  APNS_DEVICE_REGISTRATION_SECRET,
  APNS_ENVIRONMENT_SECRET,
  APNS_KEY_ID_SECRET,
  APNS_PRIVATE_KEY_SECRET,
  APNS_TEAM_ID_SECRET,
  readSelfHostedNotificationsConfigured,
} from "../notifications/config.ts";
import { resolveCliAuthConfig, authLocationFlags, type CliAuthLocationFlags } from "./config.ts";

class ApnsPrivateKeyInvalidError extends Schema.TaggedError<ApnsPrivateKeyInvalidError>()(
  "ApnsPrivateKeyInvalidError",
  { path: Schema.String },
) {
  override get message(): string {
    return `The APNs private key at '${this.path}' is not a PKCS#8 private key.`;
  }
}

const runWithNotificationSecrets = <A, E>(
  flags: CliAuthLocationFlags,
  operation: (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      return yield* operation(secrets);
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const teamIdFlag = Flag.string("team-id").pipe(Flag.withDescription("Apple Developer Team ID."));
const keyIdFlag = Flag.string("key-id").pipe(Flag.withDescription("APNs signing key ID."));
const bundleIdFlag = Flag.string("bundle-id").pipe(
  Flag.withDescription("iOS app bundle identifier used for APNs."),
);
const privateKeyFileFlag = Flag.string("private-key-file").pipe(
  Flag.withDescription("Path to the downloaded APNs .p8 private key."),
);
const environmentFlag = Flag.choice("environment", ["sandbox", "production"] as const).pipe(
  Flag.withDescription("APNs environment used by this installed build."),
  Flag.withDefault("sandbox"),
);

const configureCommand = Command.make("configure", {
  ...authLocationFlags,
  teamId: teamIdFlag,
  keyId: keyIdFlag,
  bundleId: bundleIdFlag,
  privateKeyFile: privateKeyFileFlag,
  environment: environmentFlag,
}).pipe(
  Command.withDescription("Configure account-free APNs notifications for this environment."),
  Command.withHandler((flags) =>
    runWithNotificationSecrets(flags, (secrets) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const privateKey = (yield* fileSystem.readFileString(flags.privateKeyFile)).trim();
        if (!privateKey.includes("BEGIN PRIVATE KEY")) {
          return yield* new ApnsPrivateKeyInvalidError({ path: flags.privateKeyFile });
        }
        const encode = (value: string) => new TextEncoder().encode(value);
        yield* Effect.all(
          [
            secrets.set(APNS_TEAM_ID_SECRET, encode(flags.teamId.trim())),
            secrets.set(APNS_KEY_ID_SECRET, encode(flags.keyId.trim())),
            secrets.set(APNS_BUNDLE_ID_SECRET, encode(flags.bundleId.trim())),
            secrets.set(APNS_ENVIRONMENT_SECRET, encode(flags.environment)),
            secrets.set(APNS_PRIVATE_KEY_SECRET, encode(privateKey)),
          ],
          { concurrency: 5, discard: true },
        );
        yield* Console.log(
          [
            "Self-hosted notifications configured.",
            `  Team: ${flags.teamId.trim()}`,
            `  Key: ${flags.keyId.trim()}`,
            `  Bundle: ${flags.bundleId.trim()}`,
            `  APNs: ${flags.environment}`,
            "Restart T3 Code, then open the mobile app to register this iPhone.",
          ].join("\n"),
        );
      }),
    ),
  ),
);

const statusCommand = Command.make("status", authLocationFlags).pipe(
  Command.withDescription("Show self-hosted notification configuration status."),
  Command.withHandler((flags) =>
    runWithNotificationSecrets(flags, (secrets) =>
      Effect.gen(function* () {
        const configured = yield* readSelfHostedNotificationsConfigured(secrets);
        const registration = yield* secrets.get(APNS_DEVICE_REGISTRATION_SECRET);
        yield* Console.log(
          [
            `Configured: ${configured ? "yes" : "no"}`,
            `iPhone registered: ${Option.isSome(registration) ? "yes" : "no"}`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const disableCommand = Command.make("disable", authLocationFlags).pipe(
  Command.withDescription("Remove APNs credentials and the registered mobile device."),
  Command.withHandler((flags) =>
    runWithNotificationSecrets(flags, (secrets) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [
            APNS_TEAM_ID_SECRET,
            APNS_KEY_ID_SECRET,
            APNS_PRIVATE_KEY_SECRET,
            APNS_BUNDLE_ID_SECRET,
            APNS_ENVIRONMENT_SECRET,
            APNS_DEVICE_REGISTRATION_SECRET,
          ],
          secrets.remove,
          { concurrency: 6, discard: true },
        );
        yield* Console.log("Self-hosted notifications disabled and local credentials removed.");
      }),
    ),
  ),
);

export const notificationsCommand = Command.make("notifications").pipe(
  Command.withDescription("Manage direct self-hosted iPhone notifications."),
  Command.withSubcommands([configureCommand, statusCommand, disableCommand]),
);
