import { describe, expect, it } from "@effect/vitest";

import { workspaceThreadNeedsFinishConfirmation } from "./workspacePaneLifecycle";

const idleThread = {
  session: { status: "ready" },
  backgroundLiveness: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("workspaceThreadNeedsFinishConfirmation", () => {
  it("does not interrupt an idle finish with a confirmation", () => {
    expect(workspaceThreadNeedsFinishConfirmation(idleThread)).toBe(false);
    expect(workspaceThreadNeedsFinishConfirmation(null)).toBe(false);
  });

  it.each(["starting", "running"])("confirms before finishing a %s session", (status) => {
    expect(
      workspaceThreadNeedsFinishConfirmation({
        ...idleThread,
        session: { status },
      }),
    ).toBe(true);
  });

  it("confirms before finishing background or waiting work", () => {
    expect(
      workspaceThreadNeedsFinishConfirmation({
        ...idleThread,
        backgroundLiveness: "monitoring",
      }),
    ).toBe(true);
    expect(
      workspaceThreadNeedsFinishConfirmation({
        ...idleThread,
        hasPendingApprovals: true,
      }),
    ).toBe(true);
    expect(
      workspaceThreadNeedsFinishConfirmation({
        ...idleThread,
        hasPendingUserInput: true,
      }),
    ).toBe(true);
  });
});
