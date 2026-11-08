import {
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
} from "@t3tools/client-runtime/rpc";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import type { SavedRemoteConnection } from "../../lib/connection";

const REQUEST_TIMEOUT_MS = 10_000;
const directHttpClientLayer = layerRemoteHttpClient(fetch);

function authorizationHeaders(connection: SavedRemoteConnection) {
  return connection.bearerToken ? { authorization: `Bearer ${connection.bearerToken}` } : {};
}

export const readDirectNotificationStatus = Effect.fn("readDirectNotificationStatus")(function* (
  connection: SavedRemoteConnection,
) {
  const client = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
  const urls = makeEnvironmentHttpApiUrlBuilder(connection.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    urls.notifications.status(),
    REQUEST_TIMEOUT_MS,
    client.notifications.status({ headers: authorizationHeaders(connection) }),
  );
}, Effect.provide(directHttpClientLayer));

export const registerDirectNotificationDevice = Effect.fn("registerDirectNotificationDevice")(
  function* (input: {
    readonly connection: SavedRemoteConnection;
    readonly payload: RelayDeviceRegistrationRequest;
  }) {
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
  },
  Effect.provide(directHttpClientLayer),
);
