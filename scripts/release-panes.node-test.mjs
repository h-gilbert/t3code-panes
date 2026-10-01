import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { forkReleaseVersion, latestForkReleaseTag, latestMacYaml } from "./release-panes.mjs";

NodeTest.test("fork release versions keep the upstream core and sort by time", () => {
  NodeAssert.equal(forkReleaseVersion("0.0.44", 1790900000000), "0.0.44-panes.1790900000000");
  NodeAssert.equal(forkReleaseVersion("0.0.44-dev", 1790900000000), "0.0.44-panes.1790900000000");
});

NodeTest.test("the newest fork release tag is chosen by timestamp, ignoring other tags", () => {
  NodeAssert.equal(
    latestForkReleaseTag([
      "v0.0.44-panes.1790800000000",
      "v0.0.45",
      "panes-v0.0.44-20260930.1",
      "v0.0.44-panes.1790900000000",
      "v0.0.44-panes.1790747399448.b7183457",
    ]),
    "v0.0.44-panes.1790900000000",
  );
  NodeAssert.equal(latestForkReleaseTag(["v0.0.45"]), undefined);
});

NodeTest.test("the macOS update manifest points at the signed archive", () => {
  const yaml = latestMacYaml({
    version: "0.0.44-panes.1790900000000",
    fileName: "T3-Code-0.0.44-panes.1790900000000-mac-arm64.zip",
    sha512: "abc==",
    size: 42,
    releaseDate: "2026-10-02T00:00:00.000Z",
  });
  NodeAssert.match(yaml, /^version: 0\.0\.44-panes\.1790900000000$/m);
  NodeAssert.match(yaml, /^ {2}- url: T3-Code-0\.0\.44-panes\.1790900000000-mac-arm64\.zip$/m);
  NodeAssert.match(yaml, /^sha512: abc==$/m);
  NodeAssert.match(yaml, /^ {4}size: 42$/m);
});
