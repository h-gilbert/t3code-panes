import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  forkReleaseVersion,
  installedAppPath,
  latestForkReleaseTag,
  latestMacYaml,
  parseSigningIdentities,
  selectSigningIdentity,
  signingRequirement,
} from "./release-panes.mjs";

function appFixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-app-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    journal: NodePath.join(root, "installation.json"),
    alpha: NodePath.join(root, "T3 Code (Alpha).app"),
    beta: NodePath.join(root, "T3 Code (Beta).app"),
  };
}

NodeTest.test("release signing uses an existing recorded app even when both names exist", (t) => {
  const { root, journal, alpha, beta } = appFixture(t);
  NodeFS.mkdirSync(alpha);
  NodeFS.mkdirSync(beta);
  NodeFS.writeFileSync(journal, JSON.stringify({ app: alpha }));
  NodeAssert.equal(installedAppPath(journal, root), alpha);
});

NodeTest.test("release signing finds a renamed Beta app without rewriting the old journal", (t) => {
  const { root, journal, alpha, beta } = appFixture(t);
  const record = JSON.stringify({ app: alpha, home: "preserve", profile: "preserve" });
  NodeFS.writeFileSync(journal, record);
  NodeFS.mkdirSync(beta);
  NodeAssert.equal(installedAppPath(journal, root), beta);
  NodeAssert.equal(NodeFS.readFileSync(journal, "utf8"), record);
});

NodeTest.test("release signing requires one unambiguous fallback installation", (t) => {
  const { root, journal, alpha, beta } = appFixture(t);
  NodeAssert.throws(() => installedAppPath(journal, root), /found 0/);
  NodeFS.mkdirSync(alpha);
  NodeAssert.equal(installedAppPath(journal, root), alpha);
  NodeFS.mkdirSync(beta);
  NodeAssert.throws(() => installedAppPath(journal, root), /found 2/);
  NodeFS.writeFileSync(journal, JSON.stringify({ app: NodePath.join(root, "missing.app") }));
  NodeAssert.throws(() => installedAppPath(journal, root), /found 2/);
});

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

const renewed = {
  fingerprint: "B".repeat(40),
  name: "Apple Development: Renewed",
  team: "ABCDEFGHIJ",
};
const previous = {
  fingerprint: "A".repeat(40),
  name: "Apple Development: Previous",
  team: "ABCDEFGHIJ",
};
const selection = { team: "ABCDEFGHIJ", authority: previous.name };

NodeTest.test(
  "renewed signing identities replace an expired certificate without changing teams",
  () => {
    NodeAssert.equal(selectSigningIdentity([previous, renewed], selection), previous);
    NodeAssert.equal(selectSigningIdentity([renewed], selection), renewed);
    NodeAssert.throws(() => selectSigningIdentity([], selection), /found 0/);
    NodeAssert.throws(
      () => selectSigningIdentity([{ ...renewed, team: "OTHERTEAM1" }], selection),
      /found 0/,
    );
    NodeAssert.throws(
      () => selectSigningIdentity([{ ...renewed, name: "Apple Distribution: Renewed" }], selection),
      /found 0/,
    );
  },
);

NodeTest.test("explicit signing identities must be valid and unambiguous", () => {
  NodeAssert.equal(
    selectSigningIdentity([renewed], {
      ...selection,
      configured: renewed.fingerprint.toLowerCase(),
    }),
    renewed,
  );
  NodeAssert.equal(
    selectSigningIdentity([renewed], { ...selection, configured: renewed.name }),
    renewed,
  );
  NodeAssert.throws(
    () => selectSigningIdentity([renewed], { ...selection, configured: previous.name }),
    /found 0/,
  );
  NodeAssert.throws(
    () => selectSigningIdentity([renewed, { ...renewed, fingerprint: "C".repeat(40) }], selection),
    /found 2/,
  );
});

NodeTest.test(
  "keychain parsing excludes expired identity lines and needs certificate team evidence",
  () => {
    const output = `  1) ${previous.fingerprint} "${previous.name}" (CSSMERR_TP_CERT_EXPIRED)
  2) ${renewed.fingerprint} "${renewed.name}"
     1 valid identities found`;
    NodeAssert.deepEqual(parseSigningIdentities(output, ""), [{ ...renewed, team: undefined }]);
    NodeAssert.throws(
      () => selectSigningIdentity(parseSigningIdentities(output, ""), selection),
      /found 0/,
    );
  },
);

NodeTest.test(
  "updater requirements preserve the app and Apple team across certificate renewals",
  () => {
    const requirement = signingRequirement("com.t3tools.t3code", "ABCDEFGHIJ");
    NodeAssert.match(requirement, /identifier "com.t3tools.t3code"/);
    NodeAssert.match(requirement, /anchor apple generic/);
    NodeAssert.match(requirement, /certificate leaf\[subject.OU\] = "ABCDEFGHIJ"/);
    NodeAssert.match(requirement, /certificate leaf\[field.1.2.840.113635.100.6.1.12\] exists/);
    NodeAssert.doesNotMatch(requirement, /subject.CN/);
    NodeAssert.throws(() => signingRequirement('app" or true', "ABCDEFGHIJ"), /Invalid/);
    NodeAssert.throws(() => signingRequirement("com.t3tools.t3code", 'TEAM" or true'), /Invalid/);
  },
);
