/* oxlint-disable t3code/no-global-process-runtime -- This standalone release command is the host boundary, outside the Effect application. */
/**
 * Publishes a fork release that installed apps and servers update to on their own.
 *
 *   vp run release:panes            build, publish, and wait for the Linux server build
 *   vp run release:panes --no-wait  return once the GitHub workflow has started
 *   vp run release:panes --no-publish  build and sign only (also prepares local promotion)
 *
 * The macOS app is built here because it must be signed with the same
 * certificate as the installed app, or macOS refuses the update. The Linux
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
import { bundleInfo, run, sourceIdentity, treeDigest, writeJson } from "./promote-desktop.mjs";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const WORKFLOW = "release-panes.yml";
const DEFAULT_APP = "/Applications/T3 Code (Alpha).app";

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

function signingIdentity() {
  const configured = process.env.T3CODE_LOCAL_SIGNING_IDENTITY?.trim();
  if (configured) return configured;
  // Updates must carry the installed app's signature, so sign with what it was signed with.
  const store = NodePath.join(NodeOS.homedir(), ".t3-promotions");
  const journal = NodePath.join(store, "installation.json");
  const app = NodeFS.existsSync(journal)
    ? JSON.parse(NodeFS.readFileSync(journal, "utf8")).app
    : DEFAULT_APP;
  const details = NodeChildProcess.spawnSync("/usr/bin/codesign", ["-dvv", app], {
    encoding: "utf8",
  });
  const authority = /^Authority=(.+)$/m.exec(details.stderr ?? "")?.[1]?.trim();
  if (!authority || !authority.startsWith("Apple Development:")) {
    throw new Error(
      `Could not read an Apple Development signature from ${app}. Set T3CODE_LOCAL_SIGNING_IDENTITY to the certificate that signed the installed app.`,
    );
  }
  return authority;
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
  const identity = signingIdentity();

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
  console.log(`Building ${version} from ${sha.slice(0, 10)}, signed by ${identity}…`);

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
  const app = NodePath.join(unpacked, "T3 Code (Alpha).app");
  const feed = NodeFS.readFileSync(NodePath.join(app, "Contents/Resources/app-update.yml"), "utf8");
  if (!feed.includes(FORK_RELEASE_REPOSITORY.split("/")[1])) {
    throw new Error("The build has no fork update feed; installed copies would never update.");
  }
  // Signed before zipping: the update manifest's checksum must cover the signed app.
  run("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    identity,
    "--preserve-metadata=entitlements,flags,runtime",
    "--timestamp=none",
    app,
  ]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
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
  NodeFS.writeFileSync(notes, releaseNotes(sha));

  // The same signed app can be installed by `vp run promote:desktop install`,
  // which is how a machine still on a local build joins the release feed.
  writeJson(NodePath.join(store, "candidate.json"), {
    version,
    source: sourceIdentity(),
    app,
    info,
    digest: treeDigest(app),
    preparedAt: new Date().toISOString(),
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
    `Published ${tag}. Installed apps show the update shortly; use "Update everywhere" to update this Mac and your servers.`,
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
