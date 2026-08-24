import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SelfHostedNotifications from "./SelfHostedNotifications.ts";

const handleNotificationRequest = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    return yield* operation.pipe(
      Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
    );
  });

export const notificationsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "notifications",
  Effect.fnUntraced(function* (handlers) {
    const notifications = yield* SelfHostedNotifications.SelfHostedNotifications;
    return handlers
      .handle("status", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* handleNotificationRequest(
            Effect.all({
              configured: notifications.configured,
              registration: notifications.getRegistration,
            }).pipe(
              Effect.map(({ configured, registration }) => ({
                configured,
                deviceRegistered: registration !== null,
                liveActivityRegistered: registration?.activityPushToken !== null,
              })),
            ),
          );
        }),
      )
      .handle("registerDevice", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { configured, aggregate } = yield* handleNotificationRequest(
            Effect.all({
              configured: notifications.configured,
              aggregate: notifications.registerDevice(args.payload),
            }),
          );
          return { ok: configured, aggregate };
        }),
      )
      .handle("unregisterDevice", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const aggregate = yield* handleNotificationRequest(
            notifications.unregisterDevice(args.params.deviceId),
          );
          return { ok: true, aggregate };
        }),
      )
      .handle("registerLiveActivity", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { configured, aggregate } = yield* handleNotificationRequest(
            Effect.all({
              configured: notifications.configured,
              aggregate: notifications.registerLiveActivity(args.payload),
            }),
          );
          return { ok: configured, aggregate };
        }),
      )
      .handle("agentActivity", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const aggregate = yield* handleNotificationRequest(notifications.getAggregate);
          return { ok: true, aggregate };
        }),
      );
  }),
);
