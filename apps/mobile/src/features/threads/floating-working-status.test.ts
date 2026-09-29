import { describe, expect, it, vi } from "vite-plus/test";

import { backgroundFloatingStatus, connectionFloatingStatus } from "./floating-working-status";

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

  it("names the environment it is retrying, and says so only after a failure", () => {
    expect(status("connecting")).toMatchObject({
      tone: "reconnecting",
      label: "Reconnecting to Mac mini...",
    });
    expect(status("reconnecting", { connectionError: "ECONNREFUSED" })).toMatchObject({
      tone: "reconnecting",
      label: "Failed to connect. Retrying Mac mini...",
    });
  });

  it("reports why the environment is unreachable", () => {
    expect(status("offline")).toMatchObject({
      tone: "unavailable",
      label: "You are offline",
    });
    expect(status("available")).toMatchObject({
      tone: "unavailable",
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

describe("backgroundFloatingStatus", () => {
  it.each([
    ["working", 1, "1 agent working"],
    ["working", 3, "3 agents working"],
    ["working", 0, "Background work"],
    ["monitoring", 2, "Monitoring"],
  ] as const)(
    "shows %s activity after the primary turn finishes",
    (backgroundLiveness, liveAgentCount, label) => {
      expect(
        backgroundFloatingStatus({ backgroundLiveness, liveAgentCount, failed: false }),
      ).toEqual({ kind: "background", label });
    },
  );
  it.each([null, undefined])(
    "clears the indicator when background work ends",
    (backgroundLiveness) => {
      expect(
        backgroundFloatingStatus({ backgroundLiveness, liveAgentCount: 2, failed: false }),
      ).toBeNull();
    },
  );
  it("does not hide a failed session behind background activity", () => {
    expect(
      backgroundFloatingStatus({
        backgroundLiveness: "monitoring",
        liveAgentCount: 1,
        failed: true,
      }),
    ).toBeNull();
  });
});
