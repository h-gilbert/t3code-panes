import { describe, expect, it } from "vite-plus/test";

import {
  isForkReleaseVersion,
  isPublishedT3Version,
  isSelfUpdatableT3Version,
} from "./releaseVersion.ts";

describe("releaseVersion", () => {
  it("separates fork releases from local fork builds", () => {
    expect(isForkReleaseVersion("0.0.44-panes.1790900000000")).toBe(true);
    // Local promotion builds carry a source digest and never self-update.
    expect(isForkReleaseVersion("0.0.44-panes.1790747399448.b7183457")).toBe(false);
    expect(isForkReleaseVersion("0.0.44")).toBe(false);
  });

  it("lets upstream releases and fork releases update themselves", () => {
    expect(isSelfUpdatableT3Version("0.0.44")).toBe(true);
    expect(isSelfUpdatableT3Version("0.0.44-nightly.20260930.12")).toBe(true);
    expect(isSelfUpdatableT3Version("0.0.44-panes.1790900000000")).toBe(true);
    // The artifact builder's default local version is not a release.
    expect(isSelfUpdatableT3Version("0.0.38-panes.1")).toBe(false);
    expect(isPublishedT3Version("0.0.44-panes.1790900000000")).toBe(false);
    expect(isSelfUpdatableT3Version("0.0.44-panes.1790747399448.b7183457")).toBe(false);
  });
});
