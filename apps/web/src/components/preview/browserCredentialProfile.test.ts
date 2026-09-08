import { describe, expect, it } from "vite-plus/test";
import { browserCredentialProfile } from "./browserCredentialProfile";

describe("browserCredentialProfile", () => {
  it("keeps legacy scope precedence when a new default profile is also present", () => {
    expect(
      browserCredentialProfile({ browserScope: "profile:work", profileId: "managed" }),
    ).toEqual({ profile: "work" });
    expect(
      browserCredentialProfile({ browserScope: "ephemeral:tab_1", profileId: "managed" }),
    ).toEqual({ profile: null });
  });
  it("preserves shared logins while separating every managed identity", () => {
    expect(browserCredentialProfile(undefined)).toEqual({ profile: null });
    expect(browserCredentialProfile({ profileId: "default" })).toEqual({ profile: null });
    expect(browserCredentialProfile({ profileId: "work" })).toEqual({
      profile: null,
      profileId: "work",
    });
    expect(browserCredentialProfile({ profileId: "incognito" })).toEqual({
      profile: null,
      profileId: "incognito",
    });
  });
});
