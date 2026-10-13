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

  it("retains the default workspace when opening a thread", () => {
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
    ).toBe(DEFAULT_WORKSPACE_KEY);
  });

  it("opens direct settings links over the default workspace", () => {
    expect(
      resolveRetainedWorkspaceKey({
        pathname: "/settings/general",
        workspaceSearch: undefined,
        previousWorkspaceKey: null,
      }),
    ).toBe(DEFAULT_WORKSPACE_KEY);
  });

  it("restores a named workspace from a settings or thread link after reload", () => {
    for (const pathname of ["/settings/appearance", "/environment-1/thread-1"]) {
      expect(
        resolveRetainedWorkspaceKey({
          pathname,
          workspaceSearch: "window-b",
          previousWorkspaceKey: null,
        }),
      ).toBe("window-b");
    }
  });
});
