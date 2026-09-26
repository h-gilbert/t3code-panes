import { useAtomValue } from "@effect/atom-react";
import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/device";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: "/api/device-hub" });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile:device-hub-access:${environmentId}`)),
);

export function useDeviceState(environmentId: EnvironmentId | null): DeviceServiceState | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : deviceEnvironment.state({ environmentId, input: {} }),
  );
  return query.data;
}

export function useDeviceHubAccess(
  environmentId: EnvironmentId,
  hostId: string,
): DeviceHubAccess | null {
  const result = useAtomValue(accessAtom(environmentId));
  return AsyncResult.isSuccess(result)
    ? { ...result.value, query: { ...result.value.query, hostId } }
    : null;
}

export function refreshDeviceHubAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(accessAtom(environmentId));
}
