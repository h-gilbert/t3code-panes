import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { createBrowserFrameActivity, holdFramesForTurn } from "./agentFrameRequests";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

const shell = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => shell.atom },
}));

type Shell = Pick<EnvironmentThreadShell, "runtime">;
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const shellAtom = Atom.make<Shell | null>(null).pipe(Atom.keepAlive);
shell.atom = shellAtom;
const setStatus = (status: OrchestrationV2ShellThreadStatus) =>
  appAtomRegistry.set(shellAtom, {
    runtime: {
      status,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-10-17T00:00:00.000Z",
    },
  });
const drawing = (tabId: string) => useBrowserSurfaceStore.getState().activityByTabId[tabId] ?? 0;

describe("holdFramesForTurn", () => {
  beforeEach(() => setStatus("idle"));

  it("keeps a hidden tab drawing until the thread's turn ends", () => {
    setStatus("running");
    holdFramesForTurn("tab-1", threadRef);
    // Later captures in the same turn reuse the lease.
    holdFramesForTurn("tab-1", threadRef);
    expect(drawing("tab-1")).toBe(1);
    setStatus("idle");
    expect(drawing("tab-1")).toBe(0);
  });

  it.each(["completed", "failed", "cancelled", "idle"] as const)(
    "releases painting when a turn becomes %s",
    (status) => {
      setStatus("running");
      holdFramesForTurn("tab-end", threadRef);
      setStatus(status);
      expect(drawing("tab-end")).toBe(0);
    },
  );

  it("does not draw for a capture outside a turn", () => {
    holdFramesForTurn("tab-2", threadRef);
    expect(drawing("tab-2")).toBe(0);
  });
});

describe("browser capture and viewer activity", () => {
  it("paints an idle thread only for actual capture or viewer demand", () => {
    setStatus("idle");
    const activity = createBrowserFrameActivity();
    activity.set("viewer-tab", true);
    activity.set("viewer-tab", true);
    expect(drawing("viewer-tab")).toBe(1);
    activity.set("viewer-tab", false);
    expect(drawing("viewer-tab")).toBe(0);
    activity.set("viewer-tab", true);
    activity.retain(new Set(["viewer-tab"]));
    expect(drawing("viewer-tab")).toBe(1);
    activity.retain(new Set());
    expect(drawing("viewer-tab")).toBe(0);
    activity.set("viewer-tab", true);
    activity.dispose();
    expect(drawing("viewer-tab")).toBe(0);
  });

  it("releases a viewer without releasing the agent's turn lease", () => {
    setStatus("running");
    holdFramesForTurn("shared-tab", threadRef);
    const activity = createBrowserFrameActivity();
    activity.set("shared-tab", true);
    expect(drawing("shared-tab")).toBe(2);
    activity.dispose();
    expect(drawing("shared-tab")).toBe(1);
    setStatus("idle");
    expect(drawing("shared-tab")).toBe(0);
  });
});
