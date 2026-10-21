import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

const leases = new Map<string, () => void>();

/** The subscription owns these leases, including cleanup when the host unmounts. */
export function createBrowserFrameActivity() {
  const active = new Map<string, () => void>();
  return {
    set(tabId: string, needed: boolean) {
      if (needed) {
        if (!active.has(tabId)) active.set(tabId, acquireBrowserSurfaceActivity(tabId));
      } else {
        active.get(tabId)?.();
        active.delete(tabId);
      }
    },
    retain(tabIds: ReadonlySet<string>) {
      for (const [tabId, release] of active) {
        if (tabIds.has(tabId)) continue;
        release();
        active.delete(tabId);
      }
    },
    dispose() {
      for (const release of active.values()) release();
      active.clear();
    },
  };
}

/**
 * Keeps a hidden tab drawing after the server asked for one of its frames, until
 * the thread's turn ends. A tab parked offscreen draws nothing, so an agent's
 * screenshot would wait forever. Later requests in the same turn reuse the lease.
 */
export function holdFramesForTurn(tabId: string, threadRef: ScopedThreadRef): void {
  if (leases.has(tabId)) return;
  const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
  if (!threadRuntimeIsActive(appAtomRegistry.get(shellAtom)?.runtime)) return;
  const releaseActivity = acquireBrowserSurfaceActivity(tabId);
  const release = () => {
    leases.delete(tabId);
    unsubscribe();
    releaseActivity();
  };
  const unsubscribe = appAtomRegistry.subscribe(shellAtom, (shell) => {
    if (!threadRuntimeIsActive(shell?.runtime)) release();
  });
  leases.set(tabId, release);
}
