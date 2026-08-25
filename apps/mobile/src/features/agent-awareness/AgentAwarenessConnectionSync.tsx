import { useEffect, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import type { SavedRemoteConnection } from "../../lib/connection";
import {
  registerAgentAwarenessConnection,
  unregisterAgentAwarenessConnection,
} from "./remoteRegistration";

// Direct connections are the only consumers of the agent-awareness connection
// map; a null bearer token means the prepared connection lease is not (or no
// longer) established, so the entry is dropped until it comes back.
function isEligible(connection: SavedRemoteConnection): boolean {
  return connection.relayManaged !== true && connection.bearerToken !== null;
}

// The fields that matter to device and live-activity registration. Presentation
// atoms recompute on every connection-phase transition, so re-registration is
// skipped unless one of these actually changed.
function connectionSignature(connection: SavedRemoteConnection): string {
  return `${connection.httpBaseUrl}|${connection.bearerToken ?? ""}`;
}

// Feeds saved environment connections to the agent-awareness module as they
// come and go. Without this the direct (self-hosted) notification path never
// runs: no permission prompt, no APNs device registration, no local
// live-activity arming. Renders nothing; mounted once at the app root so only
// this component re-renders on connection changes.
export function AgentAwarenessConnectionSync() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const registered = useRef(new Map<EnvironmentId, string>());

  useEffect(() => {
    const next = new Map<EnvironmentId, string>();
    for (const connection of Object.values(savedConnectionsById)) {
      if (!isEligible(connection)) {
        continue;
      }
      next.set(connection.environmentId, connectionSignature(connection));
    }
    for (const environmentId of registered.current.keys()) {
      if (!next.has(environmentId)) {
        unregisterAgentAwarenessConnection(environmentId);
      }
    }
    for (const connection of Object.values(savedConnectionsById)) {
      const signature = next.get(connection.environmentId);
      if (signature === undefined) {
        continue;
      }
      if (registered.current.get(connection.environmentId) !== signature) {
        registerAgentAwarenessConnection(connection);
      }
    }
    registered.current = next;
  }, [savedConnectionsById]);

  useEffect(
    () => () => {
      for (const environmentId of registered.current.keys()) {
        unregisterAgentAwarenessConnection(environmentId);
      }
    },
    [],
  );

  return null;
}
