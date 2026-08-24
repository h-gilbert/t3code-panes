import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const APNS_TEAM_ID_SECRET = "self-hosted-apns-team-id";
export const APNS_KEY_ID_SECRET = "self-hosted-apns-key-id";
export const APNS_PRIVATE_KEY_SECRET = "self-hosted-apns-private-key";
export const APNS_BUNDLE_ID_SECRET = "self-hosted-apns-bundle-id";
export const APNS_ENVIRONMENT_SECRET = "self-hosted-apns-environment";
export const APNS_DEVICE_REGISTRATION_SECRET = "self-hosted-apns-device-registration";

export const readSelfHostedNotificationsConfigured = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const configured = yield* Effect.forEach(
      [
        APNS_TEAM_ID_SECRET,
        APNS_KEY_ID_SECRET,
        APNS_PRIVATE_KEY_SECRET,
        APNS_BUNDLE_ID_SECRET,
        APNS_ENVIRONMENT_SECRET,
      ],
      (name) =>
        secrets
          .get(name)
          .pipe(
            Effect.map(
              (value) =>
                Option.isSome(value) && new TextDecoder().decode(value.value).trim().length > 0,
            ),
          ),
    );
    return configured.every(Boolean);
  }).pipe(Effect.orElseSucceed(() => false));
