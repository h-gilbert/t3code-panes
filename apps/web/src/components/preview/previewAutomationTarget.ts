import { DEFAULT_BROWSER_PROFILE_ID, type PreviewSessionSnapshot } from "@t3tools/contracts";

interface PreviewAutomationSessionIndex {
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}

export function needsPreviewAutomationSessionSync(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean {
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  );
}

export function resolvePreviewAutomationTarget(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | null,
): { readonly tabId: string | null; readonly snapshot: PreviewSessionSnapshot | null } {
  const snapshot = requestedTabId ? (state.sessions[requestedTabId] ?? null) : state.snapshot;
  return { tabId: snapshot?.tabId ?? null, snapshot };
}

export function resolvePreviewAutomationOpenTab(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
  requestedBrowserScope?: "ephemeral" | `profile:${string}`,
  requestedProfileId?: string,
): string | null {
  if (!reuseExistingTab) return null;
  const current = requestedTabId !== undefined ? state.sessions[requestedTabId] : state.snapshot;
  if (!current) return null;
  // A requested profile or ephemeral session must not silently land in a
  // reused tab from another storage scope; ephemeral requests always mean a
  // fresh partition, so they never reuse.
  if (requestedBrowserScope === "ephemeral") return null;
  if (requestedBrowserScope !== undefined && current.browserScope !== requestedBrowserScope) {
    return null;
  }
  if (
    requestedBrowserScope === undefined &&
    requestedProfileId !== undefined &&
    (current.browserScope ||
      (current.profileId ?? DEFAULT_BROWSER_PROFILE_ID) !== requestedProfileId)
  ) {
    return null;
  }
  return current.tabId;
}
