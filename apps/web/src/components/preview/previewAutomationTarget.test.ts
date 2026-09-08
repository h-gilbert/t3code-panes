import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("preview automation target selection", () => {
  it("refreshes authoritative sessions whenever the caller relies on the active tab", () => {
    const active = snapshot("tab-active");
    expect(
      needsPreviewAutomationSessionSync(
        { snapshot: active, sessions: { [active.tabId]: active } },
        undefined,
      ),
    ).toBe(true);
  });

  it("refreshes an explicit tab only when it is absent locally", () => {
    const active = snapshot("tab-active");
    const state = { snapshot: active, sessions: { [active.tabId]: active } };
    expect(needsPreviewAutomationSessionSync(state, active.tabId)).toBe(false);
    expect(needsPreviewAutomationSessionSync(state, "tab-missing")).toBe(true);
  });

  it("does not report the active tab under an unknown requested tab id", () => {
    const active = snapshot("tab-active");
    expect(
      resolvePreviewAutomationTarget(
        { snapshot: active, sessions: { [active.tabId]: active } },
        "tab-missing",
      ),
    ).toEqual({ tabId: null, snapshot: null });
  });

  it("reuses the provider session's pinned tab instead of the mutable UI tab", () => {
    const uiActive = snapshot("tab-ui-active");
    const agentTab = snapshot("tab-opened-by-agent");
    const state = {
      snapshot: uiActive,
      sessions: { [uiActive.tabId]: uiActive, [agentTab.tabId]: agentTab },
    };

    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, true)).toBe(agentTab.tabId);
    expect(resolvePreviewAutomationOpenTab(state, undefined, true)).toBe(uiActive.tabId);
    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, false)).toBeNull();
  });

  it("honors an explicit managed profile even for a pinned provider tab", () => {
    const active = { ...snapshot("tab_work"), profileId: "work" };
    const state = { snapshot: active, sessions: { [active.tabId]: active } };
    expect(
      resolvePreviewAutomationOpenTab(state, active.tabId, true, undefined, "other"),
    ).toBeNull();
    expect(resolvePreviewAutomationOpenTab(state, active.tabId, true, undefined, "work")).toBe(
      active.tabId,
    );
    expect(resolvePreviewAutomationOpenTab(state, active.tabId, true, "ephemeral")).toBeNull();
    expect(resolvePreviewAutomationOpenTab(state, active.tabId, true, "profile:work")).toBeNull();
  });

  it("never reuses a tab from a different storage scope", () => {
    const sharedTab = snapshot("tab_shared");
    const state = { snapshot: sharedTab, sessions: { [sharedTab.tabId]: sharedTab } };

    // An ephemeral request always means a fresh partition — reusing any
    // existing tab would silently hand the agent stored cookies.
    expect(resolvePreviewAutomationOpenTab(state, undefined, true, "ephemeral")).toBeNull();
    // A profile request must not land in the shared tab.
    expect(resolvePreviewAutomationOpenTab(state, undefined, true, "profile:work")).toBeNull();

    const profiledTab = { ...snapshot("tab_work"), browserScope: "profile:work" };
    const profiledState = { snapshot: profiledTab, sessions: { [profiledTab.tabId]: profiledTab } };
    expect(resolvePreviewAutomationOpenTab(profiledState, undefined, true, "profile:work")).toBe(
      profiledTab.tabId,
    );
    // No stated scope keeps the historical reuse behaviour.
    expect(resolvePreviewAutomationOpenTab(profiledState, undefined, true)).toBe(profiledTab.tabId);
  });
});
