import type { DesktopUpdateState } from "@t3tools/contracts";

import { useSavedServerUpdateTargets, useUpdateServers } from "./ServerUpdateAction";

/**
 * "Update everywhere": saved servers behind the desktop update's version are
 * updated to that same version before this app restarts, because restarting
 * also stops the app's own server.
 */
export function useDesktopUpdateServers(state: DesktopUpdateState | null) {
  const version = state?.downloadedVersion ?? state?.availableVersion ?? null;
  const targets = useSavedServerUpdateTargets(version ?? undefined);
  const updateServers = useUpdateServers();
  const included = version ? targets : [];
  return {
    serverLabels: included.map((target) => target.serverLabel),
    /** Resolves false when the user declined part of the update. */
    updateServersFirst: (): Promise<boolean> =>
      included.length > 0 ? updateServers(included) : Promise.resolve(true),
  };
}
