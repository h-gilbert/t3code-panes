import { describe, expect, it } from "vite-plus/test";

import { getAutomaticRemoteProjectDestination } from "./remoteProjectProvisioning";

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
