/* oxlint-disable t3code/no-global-process-runtime -- This standalone release command is the host boundary, outside the Effect application. */
/**
 * Publishes a fork release that installed apps and servers update to on their own.
 *
 *   vp run release:panes            build, publish, and wait for the Linux server build
 *   vp run release:panes --no-wait  return once the GitHub workflow has started
 *   vp run release:panes --no-publish  build and sign only (also prepares local promotion)
 *
 * The macOS app is built here to use the maintainer's Apple signing key.
 * Signing and updater compatibility are checked before building. The Linux
 * server is built by .github/workflows/release-panes.yml, which publishes the
 * draft release once both halves are attached, so no updater ever sees half a
 * release. See docs/operations/fork-releases.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { FORK_RELEASE_REPOSITORY } from "../packages/shared/src/releaseVersion.ts";
import {
  bundleInfo,
  findAppBundle,
  run,
  sourceIdentity,
  treeDigest,
  writeJson,
} from "./promote-desktop.mjs";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const WORKFLOW = "release-panes.yml";

export function installedAppPath(journal, applications = "/Applications") {
  if (NodeFS.existsSync(journal)) {
    const recorded = JSON.parse(NodeFS.readFileSync(journal, "utf8")).app;
    if (typeof recorded === "string" && NodeFS.existsSync(recorded)) return recorded;
  }
  const candidates = ["T3 Code (Alpha).app", "T3 Code (Beta).app"]
    .map((name) => NodePath.join(applications, name))
    .filter((app) => NodeFS.existsSync(app));
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one installed T3 Code app, found ${candidates.length}. Check the promotion journal or installed Alpha/Beta copies.`,
    );
  }
  return candidates[0];
}

/** Every fork release is `<upstream core>-panes.<timestamp>`, so newer always sorts higher. */
export function forkReleaseVersion(desktopPackageVersion, now) {
  return `${desktopPackageVersion.split("-")[0]}-panes.${now}`;
}

/** The manifest electron-updater reads to find and verify the macOS update. */
export function latestMacYaml({ version, fileName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

/** Newest fork release tag, by the timestamp in its version. */
export function latestForkReleaseTag(tags) {
  return tags
    .map((tag) => ({ tag, stamp: /^v\d+\.\d+\.\d+-panes\.(\d{13})$/.exec(tag)?.[1] }))
    .filter((entry) => entry.stamp !== undefined)
    .toSorted((left, right) => Number(right.stamp) - Number(left.stamp))[0]?.tag;
}

/** Valid keychain identities only; expired certificates are excluded by security -v. */
export function parseSigningIdentities(output, certificatesPem) {
  const teams = new Map();
  for (const pem of certificatesPem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  ) ?? []) {
    const certificate = new NodeCrypto.X509Certificate(pem);
    teams.set(
      certificate.fingerprint.replaceAll(":", ""),
      /^OU=(.+)$/m.exec(certificate.subject)?.[1],
    );
  }
  return [...output.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "(.+)"\s*$/gm)].map((match) => ({
    fingerprint: match[1],
    name: match[2],
    team: teams.get(match[1]),
  }));
}

export function selectSigningIdentity(identities, { team, authority, configured }) {
  const compatible = identities.filter(
    (identity) => identity.team === team && identity.name.startsWith("Apple Development:"),
  );
  const preferred = configured
    ? compatible.filter(
        (identity) =>
          identity.fingerprint === configured.toUpperCase() || identity.name === configured,
      )
    : compatible.filter((identity) => identity.name === authority);
  const candidates = preferred.length || configured ? preferred : compatible;
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one valid Apple Development signing identity for team ${team}, found ${candidates.length}. Renew an expired certificate or set T3CODE_LOCAL_SIGNING_IDENTITY to a valid certificate's SHA-1 fingerprint.`,
    );
  }
  return candidates[0];
}

/** Pin the app, Apple certificate type, and team while allowing certificate renewal. */
export function signingRequirement(identifier, team) {
  if (!/^[A-Za-z0-9.-]+$/.test(identifier) || !/^[A-Z0-9]{10}$/.test(team)) {
    throw new Error("Invalid installed app identifier or Apple team identifier.");
  }
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${team}" and certificate 1[field.1.2.840.113635.100.6.2.1] exists and certificate leaf[field.1.2.840.113635.100.6.1.12] exists`;
}

function signingPreflight(allowSigningChange) {
  const store = NodePath.join(NodeOS.homedir(), ".t3-promotions");
  const journal = NodePath.join(store, "installation.json");
  const app = installedAppPath(journal);
  const details = NodeChildProcess.spawnSync("/usr/bin/codesign", ["-dvv", "-r-", app], {
    encoding: "utf8",
  });
  if (details.error) throw details.error;
  const metadata = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  const authority = /^Authority=(.+)$/m.exec(metadata)?.[1]?.trim();
  const team = /^TeamIdentifier=(.+)$/m.exec(metadata)?.[1]?.trim();
  const identifier = /^Identifier=(.+)$/m.exec(metadata)?.[1]?.trim();
  const installedRequirement = /^designated => (.+)$/m.exec(metadata)?.[1]?.trim();
  if (
    details.status !== 0 ||
    !authority?.startsWith("Apple Development:") ||
    !team ||
    !identifier ||
    !installedRequirement
  ) {
    throw new Error(
      `Could not read an Apple Development signature and updater requirement from ${app}.`,
    );
  }
  const identity = selectSigningIdentity(
    parseSigningIdentities(
      run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]),
      run("/usr/bin/security", ["find-certificate", "-a", "-p"]),
    ),
    { team, authority, configured: process.env.T3CODE_LOCAL_SIGNING_IDENTITY?.trim() },
  );
  const requirement = signingRequirement(identifier, team);
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-signing-"));
  try {
    const probe = NodePath.join(temporary, "probe");
    NodeFS.copyFileSync("/usr/bin/true", probe);
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity.fingerprint,
      "--identifier",
      identifier,
      "--requirements",
      `=designated => ${requirement}`,
      "--timestamp",
      probe,
    ]);
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--test-requirement",
      `=${requirement}`,
      probe,
    ]);
    const compatibility = NodeChildProcess.spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--test-requirement", `=${installedRequirement}`, probe],
      { encoding: "utf8" },
    );
    if (compatibility.error) throw compatibility.error;
    const requiresLocalInstall = compatibility.status !== 0;
    if (requiresLocalInstall && !allowSigningChange) {
      throw new Error(
        "The valid signing certificate cannot satisfy the installed app's updater requirement. Rerun with --allow-signing-change only for an intentional certificate migration, then install this release once with vp run promote:desktop install after safely quitting the app.",
      );
    }
    if (requiresLocalInstall)
      console.log(
        "Certificate migration: this Mac needs a one-time local installation after release.",
      );
    return { identity, identifier, requirement, installedRequirement, requiresLocalInstall };
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

function sha512Base64(file) {
  return NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(file)).digest("base64");
}

function releaseNotes(sha) {
  const tags = run("git", ["ls-remote", "--tags", "--refs", "origin", "v*-panes.*"])
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter(Boolean);
  const previous = latestForkReleaseTag(tags);
  if (previous) run("git", ["fetch", "--quiet", "origin", "tag", previous]);
  const range = previous ? `${previous}..${sha}` : sha;
  const log = run("git", [
    "log",
    "--no-merges",
    "--format=- %s",
    ...(previous ? [] : ["-20"]),
    range,
  ]);
  return [
    previous ? `Changes since ${previous}:` : "Recent changes:",
    "",
    log || "- No new commits.",
    "",
    `Built from ${sha}.`,
    "",
  ].join("\n");
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      wait: { type: "boolean", default: true },
      publish: { type: "boolean", default: true },
      "allow-signing-change": { type: "boolean", default: false },
    },
    allowNegative: true,
  });
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Fork releases are built on an Apple Silicon Mac.");
  }
  if (run("git", ["status", "--porcelain"])) {
    throw new Error("Commit or stash your changes first: a release is built from a pushed commit.");
  }
  run("git", ["fetch", "--quiet", "origin", "main"]);
  const sha = run("git", ["rev-parse", "HEAD"]);
  if (
    values.publish &&
    NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
      cwd: repo,
    }).status !== 0
  ) {
    throw new Error(
      "Push this commit to origin/main first; the Linux server is built from GitHub.",
    );
  }
  if (values.publish) run("gh", ["auth", "status"]);
  const signing = signingPreflight(values["allow-signing-change"]);

  const desktopPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repo, "apps/desktop/package.json"), "utf8"),
  );
  const stamp = Date.now();
  const version = forkReleaseVersion(desktopPackage.version, stamp);
  const tag = `v${version}`;
  const store = NodePath.join(NodeOS.homedir(), ".t3-promotions");
  const directory = NodePath.join(store, `release-${stamp}`);
  const worktree = NodePath.join(directory, "source");
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  console.log(`Building ${version} from ${sha.slice(0, 10)}, signed by ${signing.identity.name}…`);

  // A separate worktree stamps the release version into every package without
  // touching the checkout people are working in.
  run("git", ["worktree", "add", "--detach", worktree, sha]);
  try {
    const env = NodePath.join(repo, ".env");
    if (NodeFS.existsSync(env)) NodeFS.symlinkSync(env, NodePath.join(worktree, ".env"));
    const vp = NodePath.join(repo, "node_modules/.bin/vp");
    run(vp, ["install"], { cwd: worktree, stdio: "inherit" });
    run(process.execPath, ["scripts/update-release-package-versions.ts", version], {
      cwd: worktree,
      stdio: "inherit",
    });
    run(
      process.execPath,
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "mac",
        "--target",
        "zip",
        "--arch",
        "arm64",
        "--build-version",
        version,
        "--output-dir",
        NodePath.join(directory, "build"),
      ],
      {
        cwd: worktree,
        stdio: "inherit",
        env: { ...process.env, T3CODE_DESKTOP_UPDATE_REPOSITORY: FORK_RELEASE_REPOSITORY },
      },
    );
  } finally {
    run("git", ["worktree", "remove", "--force", worktree]);
  }

  const built = NodeFS.readdirSync(NodePath.join(directory, "build")).filter((file) =>
    file.endsWith(".zip"),
  );
  if (built.length !== 1) throw new Error(`Expected one ZIP in ${directory}/build.`);
  const unpacked = NodePath.join(directory, "unpacked");
  run("/usr/bin/ditto", ["-x", "-k", NodePath.join(directory, "build", built[0]), unpacked]);
  const app = findAppBundle(unpacked);
  const feed = NodeFS.readFileSync(NodePath.join(app, "Contents/Resources/app-update.yml"), "utf8");
  if (!feed.includes(FORK_RELEASE_REPOSITORY.split("/")[1])) {
    throw new Error("The build has no fork update feed; installed copies would never update.");
  }
  // Signed before zipping: the update manifest's checksum must cover the signed app.
  run("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    signing.identity.fingerprint,
    "--preserve-metadata=entitlements,flags,runtime",
    "--timestamp",
    app,
  ]);
  // Apply the app requirement only to the outer bundle, not its nested helpers.
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    signing.identity.fingerprint,
    "--preserve-metadata=entitlements,flags,runtime",
    "--requirements",
    `=designated => ${signing.requirement}`,
    "--timestamp",
    app,
  ]);
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--test-requirement",
    `=${signing.requirement}`,
    app,
  ]);
  if (!signing.requiresLocalInstall) {
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--test-requirement",
      `=${signing.installedRequirement}`,
      app,
    ]);
  }
  const info = bundleInfo(app);
  if (info.version !== version) throw new Error(`Built ${info.version}, expected ${version}.`);

  const fileName = `T3-Code-${version}-mac-arm64.zip`;
  const archive = NodePath.join(directory, fileName);
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  const manifest = NodePath.join(directory, "latest-mac.yml");
  NodeFS.writeFileSync(
    manifest,
    latestMacYaml({
      version,
      fileName,
      sha512: sha512Base64(archive),
      size: NodeFS.statSync(archive).size,
      releaseDate: new Date().toISOString(),
    }),
  );
  const notes = NodePath.join(directory, "notes.md");
  NodeFS.writeFileSync(
    notes,
    [
      ...(signing.requiresLocalInstall
        ? [
            "Mac signing certificate renewed. Older Mac installations pin the expired certificate and need a one-time local installation of this release. Future releases accept renewed Apple Development certificates from the same team. Server updates are unchanged.",
            "",
          ]
        : []),
      releaseNotes(sha),
    ].join("\n"),
  );

  // The same signed app can be installed by `vp run promote:desktop install`,
  // which is how a machine still on a local build joins the release feed.
  writeJson(NodePath.join(store, "candidate.json"), {
    version,
    source: sourceIdentity(),
    app,
    info,
    digest: treeDigest(app),
    preparedAt: new Date().toISOString(),
    requiresLocalInstall: signing.requiresLocalInstall,
  });

  if (!values.publish) {
    console.log(
      `Built ${version} without publishing. Install it with: vp run promote:desktop install`,
    );
    return;
  }

  run(
    "gh",
    [
      "release",
      "create",
      tag,
      "--repo",
      FORK_RELEASE_REPOSITORY,
      "--target",
      sha,
      "--draft",
      "--title",
      `T3 Code Panes ${version}`,
      "--notes-file",
      notes,
      archive,
      manifest,
    ],
    { stdio: "inherit" },
  );
  run("gh", [
    "workflow",
    "run",
    WORKFLOW,
    "--repo",
    FORK_RELEASE_REPOSITORY,
    "--ref",
    "main",
    "-f",
    `version=${version}`,
    "-f",
    `ref=${sha}`,
  ]);
  console.log(`Draft ${tag} created. GitHub is building the Linux server and will publish it.`);
  if (!values.wait) return;

  let runId;
  for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
    NodeChildProcess.spawnSync("/bin/sleep", ["2"]);
    const runs = JSON.parse(
      run("gh", [
        "run",
        "list",
        "--repo",
        FORK_RELEASE_REPOSITORY,
        "--workflow",
        WORKFLOW,
        "--json",
        "databaseId,displayTitle",
        "--limit",
        "10",
      ]),
    );
    runId = runs.find((entry) => entry.displayTitle.includes(version))?.databaseId;
  }
  if (!runId) throw new Error(`Could not find the ${WORKFLOW} run for ${version}.`);
  run("gh", ["run", "watch", String(runId), "--repo", FORK_RELEASE_REPOSITORY, "--exit-status"], {
    stdio: "inherit",
  });
  console.log(
    signing.requiresLocalInstall
      ? `Published ${tag}. After safely quitting this Mac app, install once with: vp run promote:desktop install. Servers can update from the release feed.`
      : `Published ${tag}. Installed apps show the update shortly; use "Update everywhere" to update this Mac and your servers.`,
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
