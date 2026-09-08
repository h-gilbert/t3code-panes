/* oxlint-disable t3code/no-global-process-runtime -- This standalone macOS installer is the host boundary, outside the Effect application. */
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    cwd: repo,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function readJson(file) {
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}

export function withLock(store, work) {
  NodeFS.mkdirSync(store, { recursive: true, mode: 0o700 });
  const lock = NodePath.join(store, "lock");
  try {
    NodeFS.mkdirSync(lock);
  } catch {
    throw new Error(
      `Another promotion owns ${lock}. If it crashed, confirm it has stopped before removing that directory.`,
    );
  }
  try {
    writeJson(NodePath.join(lock, "owner.json"), {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    return work();
  } finally {
    NodeFS.rmSync(lock, { recursive: true });
  }
}

export function treeDigest(root) {
  const hash = NodeCrypto.createHash("sha256");
  function visit(relative) {
    const file = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(file);
    hash.update(
      JSON.stringify([
        relative,
        stat.mode & 0o777,
        stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file",
      ]),
    );
    if (stat.isSymbolicLink()) hash.update(NodeFS.readlinkSync(file));
    else if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(file).sort()) visit(NodePath.join(relative, name));
    } else hash.update(NodeFS.readFileSync(file));
  }
  visit("");
  return hash.digest("hex");
}

export function sourceIdentity(root = repo) {
  const git = (args) => run("git", args, { cwd: root });
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const hash = NodeCrypto.createHash("sha256");
  for (const name of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    hash.update(JSON.stringify(name));
    const file = NodePath.join(root, name);
    try {
      const stat = NodeFS.lstatSync(file);
      hash.update(String(stat.mode & 0o777));
      if (stat.isDirectory()) {
        hash.update(git(["ls-files", "--stage", "--", name]));
        hash.update(treeDigest(file));
      } else {
        hash.update(stat.isSymbolicLink() ? NodeFS.readlinkSync(file) : NodeFS.readFileSync(file));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("deleted");
    }
  }
  return {
    revision: git(["rev-parse", "HEAD"]),
    digest: hash.digest("hex"),
    changes: git(["status", "--short"]),
  };
}

export function databaseSchema(home) {
  const file = NodePath.join(home, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(file)) throw new Error(`Existing production database required: ${file}`);
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
  } finally {
    db.close();
  }
}

export function assertRollbackCompatible(before, current) {
  if (JSON.stringify(before) !== JSON.stringify(current)) {
    throw new Error(
      "Rollback blocked: database migrations changed since installation. The saved app and state backup are retained. Restoring older state requires a separate recovery decision because it would discard newer work.",
    );
  }
}

function bundleInfo(app) {
  if (
    !NodePath.isAbsolute(app) ||
    !app.endsWith(".app") ||
    NodeFS.lstatSync(app).isSymbolicLink()
  ) {
    throw new Error(`Expected a real, absolute .app directory: ${app}`);
  }
  const plist = NodePath.join(app, "Contents", "Info.plist");
  const get = (key) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  const executable = get("CFBundleExecutable");
  if (NodePath.basename(executable) !== executable) throw new Error("Invalid bundle executable.");
  NodeFS.accessSync(NodePath.join(app, "Contents", "MacOS", executable), NodeFS.constants.X_OK);
  return { id: get("CFBundleIdentifier"), version: get("CFBundleShortVersionString"), executable };
}

export function assertStopped(app, homes, execute = run, listOpen = NodeChildProcess.spawnSync) {
  const processes = execute("/bin/ps", ["-ww", "-axo", "pid=,command="]);
  if (processes.split("\n").some((line) => line.includes(`${app}/Contents/`))) {
    throw new Error(
      "The installed app is still running. Finish local turns, subagents and managed terminals, then quit T3 Code normally and rerun this command. Remote servers are not stopped by this tool.",
    );
  }
  for (const home of homes.filter((directory) => NodeFS.existsSync(directory))) {
    const result = listOpen("/usr/sbin/lsof", ["-t", "+D", home], { encoding: "utf8" });
    if (result.error || result.stderr?.trim() || ![0, 1].includes(result.status)) {
      throw new Error(
        `Could not verify that ${home} is closed: ${result.error?.message ?? result.stderr}`,
      );
    }
    if (result.stdout.trim())
      throw new Error(
        `Processes still have files open in ${home}. Quit the owning local app/server normally before installing. No process was stopped.`,
      );
  }
}

export function replaceBundle({ app, staged, backup, rename = NodeFS.renameSync }) {
  if (NodeFS.existsSync(backup)) throw new Error(`Backup already exists: ${backup}`);
  rename(app, backup);
  try {
    rename(staged, app);
  } catch (error) {
    rename(backup, app);
    throw error;
  }
}

function copy(source, target) {
  run("/usr/bin/ditto", [source, target]);
}

export function assertSeparatePaths(paths) {
  const resolved = paths.map((value) => {
    const absolute = NodePath.resolve(value);
    let parent = absolute;
    while (!NodeFS.existsSync(parent)) parent = NodePath.dirname(parent);
    return NodePath.join(NodeFS.realpathSync(parent), NodePath.relative(parent, absolute));
  });
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (
        resolved[i] === resolved[j] ||
        resolved[i].startsWith(`${resolved[j]}${NodePath.sep}`) ||
        resolved[j].startsWith(`${resolved[i]}${NodePath.sep}`)
      ) {
        throw new Error(
          "Promotion storage, app, checkout and state directories must be separate, including through symlinks.",
        );
      }
    }
  }
}

function defaultProfile() {
  const base = NodePath.join(NodeOS.homedir(), "Library/Application Support");
  const legacy = NodePath.join(base, "T3 Code (Alpha)");
  return NodeFS.existsSync(legacy) ? legacy : NodePath.join(base, "t3code");
}

function prepare(store) {
  const source = sourceIdentity();
  if (run("git", ["diff", "--name-only", "--diff-filter=U"]))
    throw new Error("Resolve merge conflicts before preparing a build.");
  const baseVersion = readJson(NodePath.join(repo, "apps/desktop/package.json")).version.split(
    "-",
  )[0];
  const build = `${Date.now()}.${source.digest.slice(0, 8)}`;
  const version = `${baseVersion}-panes.${build}`;
  const directory = NodePath.join(store, build);
  NodeFS.mkdirSync(directory);
  console.log(`Checking promotion and custom-update safeguards for ${version}…`);
  run(process.execPath, ["--test", NodePath.join(repo, "scripts/promote-desktop.node-test.mjs")], {
    stdio: "inherit",
  });
  run(
    NodePath.join(repo, "node_modules/.bin/vp"),
    [
      "test",
      "run",
      "apps/desktop/src/updates/DesktopUpdates.test.ts",
      "apps/server/src/cloud/selfUpdate.test.ts",
    ],
    { stdio: "inherit" },
  );
  run(
    process.execPath,
    [
      NodePath.join(repo, "scripts/build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "zip",
      "--arch",
      NodeOS.arch(),
      "--build-version",
      version,
      "--output-dir",
      directory,
    ],
    { stdio: "inherit" },
  );
  if (sourceIdentity().digest !== source.digest)
    throw new Error(
      `Source changed during preparation. Candidate not published; build output is retained at ${directory}. Prepare again after edits stop.`,
    );
  const archives = NodeFS.readdirSync(directory).filter((file) => file.endsWith(".zip"));
  if (archives.length !== 1) throw new Error(`Expected one ZIP artifact in ${directory}.`);
  const unpacked = NodePath.join(directory, "unpacked");
  run("/usr/bin/ditto", ["-x", "-k", NodePath.join(directory, archives[0]), unpacked]);
  const apps = NodeFS.readdirSync(unpacked).filter((file) => file.endsWith(".app"));
  if (apps.length !== 1) throw new Error("Expected one app in the archive.");
  const app = NodePath.join(unpacked, apps[0]);
  const info = bundleInfo(app);
  if (info.version !== version)
    throw new Error("Packaged version does not match the requested build.");
  const candidate = {
    version,
    source,
    app,
    info,
    digest: treeDigest(app),
    preparedAt: new Date().toISOString(),
  };
  writeJson(NodePath.join(store, "candidate.json"), candidate);
  console.log(
    `Prepared ${version}. Your installed app is unchanged.\nRun promote:desktop status, then install --app '/absolute/path/T3 Code.app' after quitting at a safe point.`,
  );
}

export function install(store, values, rollback, operations = {}) {
  const inspect = operations.bundleInfo ?? bundleInfo;
  const stopped = operations.assertStopped ?? assertStopped;
  const duplicate = operations.copy ?? copy;
  const journalPath = NodePath.join(store, "installation.json");
  const previous = NodeFS.existsSync(journalPath) ? readJson(journalPath) : null;
  if (previous && previous.phase !== "installed" && previous.phase !== "rolled-back") {
    throw new Error(
      `An interrupted installation needs review: ${journalPath}. App, backup and state paths are recorded there; no further replacement was attempted.`,
    );
  }
  if (rollback && previous?.phase !== "installed")
    throw new Error("No installed promotion is available to roll back.");
  const app = NodePath.resolve(values.app ?? previous?.app ?? "");
  if (!values.app && !previous?.app)
    throw new Error("Pass --app with the exact installed .app path for the first installation.");
  const home = NodePath.resolve(
    values["home-dir"] ?? previous?.home ?? NodePath.join(NodeOS.homedir(), ".t3"),
  );
  const profile = NodePath.resolve(values["profile-dir"] ?? previous?.profile ?? defaultProfile());
  if (rollback && (app !== previous.app || home !== previous.home || profile !== previous.profile))
    throw new Error("Rollback must use the original app and state paths.");
  assertSeparatePaths([store, home, profile, app]);
  const oldInfo = inspect(app);
  stopped(app, [home, profile]);
  const schema = databaseSchema(home);
  const candidate = rollback
    ? { app: previous.backup, digest: previous.oldDigest, info: previous.oldInfo }
    : readJson(NodePath.join(store, "candidate.json"));
  if (rollback) {
    assertRollbackCompatible(previous.schema, schema);
    if (treeDigest(app) !== previous.installedDigest)
      throw new Error(
        "Installed app changed since promotion; refusing to replace it during rollback.",
      );
  }
  if (candidate.info.id !== oldInfo.id)
    throw new Error("Candidate and installed bundle identifiers differ.");
  if (treeDigest(candidate.app) !== candidate.digest)
    throw new Error("Prepared app or backup changed; integrity check failed.");
  if (!rollback && oldInfo.version === candidate.info.version)
    throw new Error("This candidate is already installed.");
  const id = `${Date.now()}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const backup = `${app}.before-${id}`;
  const staged = NodePath.join(NodePath.dirname(app), `.t3-promotion-${id}.app`);
  const stateBackup = NodePath.join(store, `state-${id}`);
  const oldDigest = treeDigest(app);
  duplicate(candidate.app, staged);
  if (treeDigest(staged) !== candidate.digest)
    throw new Error(`Staged app failed integrity verification: ${staged}`);
  stopped(app, [home, profile]);
  NodeFS.mkdirSync(stateBackup, { mode: 0o700 });
  duplicate(home, NodePath.join(stateBackup, "home"));
  if (NodeFS.existsSync(profile)) duplicate(profile, NodePath.join(stateBackup, "profile"));
  stopped(app, [home, profile]);
  if (
    treeDigest(app) !== oldDigest ||
    JSON.stringify(databaseSchema(home)) !== JSON.stringify(schema)
  ) {
    throw new Error(
      "Installed app or database migrations changed during staging. No replacement was made; close the owning app and prepare to install again.",
    );
  }
  const journal = {
    phase: "staged",
    app,
    home,
    profile,
    staged,
    backup,
    stateBackup,
    schema,
    oldInfo,
    oldDigest,
    installedDigest: candidate.digest,
    version: candidate.info.version,
    createdAt: new Date().toISOString(),
  };
  if (previous) writeJson(NodePath.join(store, `history-${id}.json`), previous);
  writeJson(journalPath, journal);
  replaceBundle({ app, staged, backup });
  if (treeDigest(app) !== candidate.digest || inspect(app).version !== candidate.info.version)
    throw new Error(`Installed verification failed. Recovery paths are in ${journalPath}.`);
  writeJson(journalPath, { ...journal, phase: rollback ? "rolled-back" : "installed" });
  if (!values["no-launch"]) {
    const launch =
      operations.launch ??
      ((bundle, stateHome) =>
        run("/usr/bin/open", ["-a", bundle, "--env", `T3CODE_HOME=${stateHome}`]));
    try {
      launch(app, home);
    } catch (error) {
      throw new Error(
        `App replacement succeeded, but reopening failed: ${error.message}. Open ${app} with T3CODE_HOME=${home}. Installation and backups are recorded in ${journalPath}.`,
        { cause: error },
      );
    }
  }
  console.log(
    `${rollback ? "Rolled back to" : "Installed"} ${candidate.info.version}.\nPrevious app: ${backup}\nState backup: ${stateBackup}\n${values["no-launch"] ? "Open the app normally" : "Requested app launch"} with the same T3 home (${home}). Check local server connection, windows and pane assignments. Server health and UI restoration require that check.`,
  );
}

export function main(args = process.argv.slice(2)) {
  const { values, positionals } = NodeUtil.parseArgs({
    args,
    allowPositionals: true,
    options: {
      store: { type: "string" },
      app: { type: "string" },
      "home-dir": { type: "string" },
      "profile-dir": { type: "string" },
      help: { type: "boolean" },
      "no-launch": { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "promote:desktop prepare | status | install | rollback\nOptions: --app <installed .app> --home-dir <production T3 home> --profile-dir <Electron profile> --store <promotion storage> --no-launch\nPreparation builds once. Install/rollback require the app and local state to be closed. They never stop processes; after replacement they reopen the app with its production home unless --no-launch is passed. Backups contain private state. Use a local, private store outside the checkout and production state.",
    );
    return;
  }
  if (!["prepare", "status", "install", "rollback"].includes(command) || positionals.length !== 1)
    throw new Error("Unknown promotion command. Use --help.");
  const store = NodePath.resolve(values.store ?? NodePath.join(NodeOS.homedir(), ".t3-promotions"));
  if (command === "status") {
    for (const name of ["candidate.json", "installation.json", "lock/owner.json"]) {
      const file = NodePath.join(store, name);
      const record = NodeFS.existsSync(file) ? readJson(file) : null;
      if (record?.source)
        record.source = {
          revision: record.source.revision,
          digest: record.source.digest,
          changedFiles: record.source.changes ? record.source.changes.split("\n").length : 0,
        };
      console.log(`${name}: ${record ? JSON.stringify(record, null, 2) : "none"}`);
    }
    return;
  }
  if (NodeOS.platform() !== "darwin")
    throw new Error("Local desktop promotion currently supports macOS only.");
  const home = NodePath.resolve(values["home-dir"] ?? NodePath.join(NodeOS.homedir(), ".t3"));
  assertSeparatePaths([store, repo, home, values["profile-dir"] ?? defaultProfile()]);
  withLock(store, () =>
    command === "prepare" ? prepare(store) : install(store, values, command === "rollback"),
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
