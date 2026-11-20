import { describe, expect, it, vi } from "vite-plus/test";

import {
  backgroundFloatingStatus,
  connectionFloatingStatus,
  connectionRetryLabel,
} from "./floating-working-status";

const status = (
  connectionState: Parameters<typeof connectionFloatingStatus>[0]["connectionState"],
  overrides: { connectionError?: string | null; environmentLabel?: string | null } = {},
) =>
  connectionFloatingStatus({
    connectionError: overrides.connectionError ?? null,
    connectionState,
    environmentLabel:
      overrides.environmentLabel === undefined ? "Mac mini" : overrides.environmentLabel,
    onReconnect: () => {},
  });

describe("connectionFloatingStatus", () => {
  it("yields the pill to sync and working state once connected", () => {
    expect(status("connected")).toBeNull();
  });

  it("leaves automatic retries to the thread header", () => {
    expect(status("connecting")).toBeNull();
    expect(status("reconnecting", { connectionError: "ECONNREFUSED" })).toBeNull();
  });

  it("reports why the environment is unreachable", () => {
    expect(status("offline")).toMatchObject({
      kind: "connection",
      label: "You are offline",
    });
    expect(status("available")).toMatchObject({
      kind: "connection",
      label: "Mac mini is not connected",
    });
    expect(status("error", { connectionError: "handshake timed out" })).toMatchObject({
      label: "Failed to connect to Mac mini: handshake timed out",
    });
    expect(status("error")).toMatchObject({ label: "Failed to connect to Mac mini" });
  });

  it("falls back to a generic name when the environment has no label", () => {
    expect(status("error", { environmentLabel: null })).toMatchObject({
      label: "Failed to connect to Environment",
    });
  });

  it("carries the reconnect handler so the pill can trigger it", () => {
    const onReconnect = vi.fn();
    const pill = connectionFloatingStatus({
      connectionError: null,
      connectionState: "offline",
      environmentLabel: "Mac mini",
      onReconnect,
    });
    if (pill?.kind !== "connection") throw new Error("expected a connection pill");
    pill.onPress();
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("connectionRetryLabel", () => {
  it("distinguishes reconnecting, retrying after an error, and waiting for approval", () => {
    expect(connectionRetryLabel({ connectionState: "connecting", connectionError: null })).toBe(
      "Reconnecting…",
    );
    expect(
      connectionRetryLabel({ connectionState: "reconnecting", connectionError: "ECONNREFUSED" }),
    ).toBe("Retrying connection…");
    expect(
      connectionRetryLabel({
        connectionState: "reconnecting",
        connectionError: "approval required",
        connectionAwaitingApproval: true,
      }),
    ).toBe("Awaiting device approval");
    expect(
      connectionRetryLabel({ connectionState: "connected", connectionError: null }),
    ).toBeNull();
  });
});

describe("backgroundFloatingStatus", () => {
  it.each([
    [[{ taskId: "one", kind: "subagent" }], "Waiting on a subagent"],
    [
      [
        { taskId: "one", kind: "subagent" },
        { taskId: "two", kind: "subagent" },
      ],
      "Waiting on 2 subagents",
    ],
    [[{ taskId: "watch", kind: "monitor", awaited: true }], "Waiting on a monitor"],
  ] as const)("keeps post-turn work visible for %j", (tasks, label) => {
    expect(backgroundFloatingStatus({ tasks, failed: false })).toMatchObject({
      kind: "background",
      label,
      waiting: true,
    });
  });
  it("distinguishes a running command from an agent still working", () => {
    expect(
      backgroundFloatingStatus({ tasks: [{ taskId: "server", kind: "command" }], failed: false }),
    ).toMatchObject({ kind: "background", waiting: false });
  });
  it("clears the indicator after background work ends", () => {
    expect(backgroundFloatingStatus({ tasks: [], failed: false })).toBeNull();
  });
  it("does not hide a failed runtime behind background activity", () => {
    expect(
      backgroundFloatingStatus({ tasks: [{ taskId: "watch", kind: "monitor" }], failed: true }),
    ).toBeNull();
  });
});
