import {
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  executeEnvironmentHttpRequest,
  remoteHttpClientLayer,
} from "@t3tools/client-runtime/rpc";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import type { SavedRemoteConnection } from "../../lib/connection";

const REQUEST_TIMEOUT_MS = 10_000;
const directHttpClientLayer = remoteHttpClientLayer(fetch);

function authorizationHeaders(connection: SavedRemoteConnection) {
  return connection.bearerToken ? { authorization: `Bearer ${connection.bearerToken}` } : {};
}

export function readDirectNotificationStatus(connection: SavedRemoteConnection) {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
    const urls = makeEnvironmentHttpApiUrlBuilder(connection.httpBaseUrl);
    return yield* executeEnvironmentHttpRequest(
      urls.notifications.status(),
      REQUEST_TIMEOUT_MS,
      client.notifications.status({ headers: authorizationHeaders(connection) }),
    );
  }).pipe(Effect.provide(directHttpClientLayer));
}

export function registerDirectNotificationDevice(input: {
  readonly connection: SavedRemoteConnection;
  readonly payload: RelayDeviceRegistrationRequest;
}) {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.connection.httpBaseUrl);
    const urls = makeEnvironmentHttpApiUrlBuilder(input.connection.httpBaseUrl);
    return yield* executeEnvironmentHttpRequest(
      urls.notifications.registerDevice(),
      REQUEST_TIMEOUT_MS,
      client.notifications.registerDevice({
        headers: authorizationHeaders(input.connection),
        payload: input.payload,
      }),
    );
  }).pipe(Effect.provide(directHttpClientLayer));
}
