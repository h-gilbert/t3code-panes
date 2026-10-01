import { describe, expect, it } from "vite-plus/test";

import {
  getAutomaticRemoteProjectDestination,
  getRemoteProjectDraftContext,
  resolvePaneEnvironmentMode,
} from "./remoteProjectProvisioning";

describe("remote project draft context", () => {
  it("can send a restored pane draft with a hidden, incomplete worktree selection", () => {
    expect(
      resolvePaneEnvironmentMode({
        embeddedPane: true,
        requestedMode: "worktree",
        branch: null,
        worktreePath: null,
      }),
    ).toBe("local");
    expect(
      resolvePaneEnvironmentMode({
        embeddedPane: false,
        requestedMode: "worktree",
        branch: null,
        worktreePath: null,
      }),
    ).toBe("worktree");
  });

  it("keeps explicit branches and existing worktrees in panes", () => {
    expect(
      resolvePaneEnvironmentMode({
        embeddedPane: true,
        requestedMode: "worktree",
        branch: "main",
        worktreePath: null,
      }),
    ).toBe("worktree");
    expect(
      resolvePaneEnvironmentMode({
        embeddedPane: true,
        requestedMode: "worktree",
        branch: null,
        worktreePath: "/lanes/example",
      }),
    ).toBe("worktree");
  });

  it("clears a pane's stale worktree request when changing machines", () => {
    expect(getRemoteProjectDraftContext({ embeddedPane: true, requestedMode: "worktree" })).toEqual(
      {
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      },
    );
  });

  it("preserves worktree selection where the branch toolbar is available", () => {
    expect(
      getRemoteProjectDraftContext({ embeddedPane: false, requestedMode: "worktree" }),
    ).toEqual({
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("getAutomaticRemoteProjectDestination", () => {
  it("nests automatic checkouts below the configured base and repository owner", () => {
    expect(
      getAutomaticRemoteProjectDestination({
        baseDirectory: "/tank/appdata/t3-workspaces",
        owner: "h-gilbert",
        remoteUrl: "git@github.com:h-gilbert/gym-trainer-devenv.git",
        workspaceRoot: "/Users/hamish/Projects/gym-trainer",
      }),
    ).toBe("/tank/appdata/t3-workspaces/h-gilbert/gym-trainer");
  });

  it("falls back to the repository name when the workspace root has no leaf", () => {
    expect(
      getAutomaticRemoteProjectDestination({
        baseDirectory: "~/",
        owner: null,
        remoteUrl: "https://github.com/acme/example.git",
        workspaceRoot: "/",
      }),
    ).toBe("~/example");
  });
});
