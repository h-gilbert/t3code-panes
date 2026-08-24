import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_WORKSPACE_KEY } from "./workspacePaneStore";
import { resolveRetainedWorkspaceKey } from "./workspaceRouteRetention";

describe("resolveRetainedWorkspaceKey", () => {
  it("retains the current named workspace throughout settings navigation", () => {
    const workspaceKey = resolveRetainedWorkspaceKey({
      pathname: "/workspace",
      workspaceSearch: "window-a",
      previousWorkspaceKey: null,
    });

    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/settings/general",
        workspaceSearch: undefined,
        previousWorkspaceKey: workspaceKey,
      }),
    ).toBe("window-a");
    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/settings/connections",
        workspaceSearch: undefined,
        previousWorkspaceKey: workspaceKey,
      }),
    ).toBe("window-a");
  });

  it("retains the default workspace and releases it on unrelated routes", () => {
    const workspaceKey = resolveRetainedWorkspaceKey({
      pathname: "/workspace",
      workspaceSearch: undefined,
      previousWorkspaceKey: null,
    });

    expect(workspaceKey).toBe(DEFAULT_WORKSPACE_KEY);
    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/settings/appearance",
        workspaceSearch: undefined,
        previousWorkspaceKey: workspaceKey,
      }),
    ).toBe(DEFAULT_WORKSPACE_KEY);
    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/environment-1/thread-1",
        workspaceSearch: undefined,
        previousWorkspaceKey: workspaceKey,
      }),
    ).toBeNull();
  });

  it("does not create a workspace when settings is opened directly", () => {
    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/settings/general",
        workspaceSearch: undefined,
        previousWorkspaceKey: null,
      }),
    ).toBeNull();
  });
});
