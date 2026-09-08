import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeSqlite from "node:sqlite";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  assertRollbackCompatible,
  assertSeparatePaths,
  assertStopped,
  databaseSchema,
  install,
  replaceBundle,
  sourceIdentity,
  treeDigest,
  withLock,
  writeJson,
  run,
} from "./promote-desktop.mjs";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-promotion-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const store = NodePath.join(root, "store");
  const home = NodePath.join(root, "home");
  const profile = NodePath.join(root, "profile");
  const app = NodePath.join(root, "installed.app");
  const candidate = NodePath.join(store, "candidate.app");
  for (const dir of [store, NodePath.join(home, "userdata"), profile, app, candidate])
    NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(app, "version"), "old");
  NodeFS.writeFileSync(NodePath.join(candidate, "version"), "new");
  NodeFS.writeFileSync(NodePath.join(profile, "pane-state"), "custom panes");
  const database = NodePath.join(home, "userdata/state.sqlite");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(
    "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL); INSERT INTO effect_sql_migrations (migration_id, name) VALUES (43, 'original'); CREATE TABLE work (message TEXT); INSERT INTO work VALUES ('original work')",
  );
  db.close();
  const inspect = (directory) => ({
    id: "test.t3",
    version: NodeFS.readFileSync(NodePath.join(directory, "version"), "utf8"),
    executable: "test",
  });
  writeJson(NodePath.join(store, "candidate.json"), {
    app: candidate,
    digest: treeDigest(candidate),
    info: inspect(candidate),
  });
  const operations = {
    launch: () => {},
    bundleInfo: inspect,
    assertStopped: () => {},
    copy: (source, target) =>
      NodeFS.cpSync(source, target, { recursive: true, verbatimSymlinks: true }),
  };
  return {
    root,
    store,
    app,
    home,
    profile,
    candidate,
    database,
    operations,
    values: { app, "home-dir": home, "profile-dir": profile },
  };
}

NodeTest.test(
  "installation backs up app and state; rollback keeps work created after installation",
  (t) => {
    const f = fixture(t);
    install(f.store, f.values, false, f.operations);
    const journal = JSON.parse(
      NodeFS.readFileSync(NodePath.join(f.store, "installation.json"), "utf8"),
    );
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "new");
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(journal.backup, "version"), "utf8"), "old");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(journal.stateBackup, "profile/pane-state"), "utf8"),
      "custom panes",
    );
    const db = new NodeSqlite.DatabaseSync(f.database);
    db.exec("INSERT INTO work VALUES ('new work')");
    db.close();
    install(f.store, {}, true, f.operations);
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "old");
    const current = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
    NodeAssert.equal(current.prepare("SELECT count(*) AS count FROM work").get().count, 2);
    current.close();
  },
);

NodeTest.test("migration changes block rollback without changing app or database", (t) => {
  const f = fixture(t);
  install(f.store, f.values, false, f.operations);
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (44, 'new schema')");
  db.close();
  NodeAssert.throws(() => install(f.store, {}, true, f.operations), /migrations changed/);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "new");
  NodeAssert.equal(databaseSchema(f.home).length, 2);
});

NodeTest.test("tampered candidate is rejected before backing up or replacing anything", (t) => {
  const f = fixture(t);
  NodeFS.writeFileSync(NodePath.join(f.candidate, "version"), "tampered");
  NodeAssert.throws(() => install(f.store, f.values, false, f.operations), /integrity/);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "old");
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.store, "installation.json")), false);
});

NodeTest.test("a running app blocks installation without mutation", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () =>
      install(f.store, f.values, false, {
        ...f.operations,
        assertStopped: () => {
          throw new Error("busy");
        },
      }),
    /busy/,
  );
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "old");
});

NodeTest.test("failed second rename restores the original app", (t) => {
  const f = fixture(t);
  const backup = `${f.app}.backup`;
  NodeAssert.throws(
    () =>
      replaceBundle({
        app: f.app,
        staged: f.candidate,
        backup,
        rename: (source, target) => {
          if (source === f.candidate) throw new Error("disk failure");
          NodeFS.renameSync(source, target);
        },
      }),
    /disk failure/,
  );
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "old");
  NodeAssert.equal(NodeFS.existsSync(backup), false);
});

NodeTest.test("unfinished journal prevents a second replacement", (t) => {
  const f = fixture(t);
  writeJson(NodePath.join(f.store, "installation.json"), { phase: "staged" });
  NodeAssert.throws(
    () => install(f.store, f.values, false, f.operations),
    /interrupted installation/,
  );
});

NodeTest.test("lock prevents concurrent promotion and is released on failure", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () => withLock(f.store, () => withLock(f.store, () => {})),
    /Another promotion/,
  );
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.store, "lock")), false);
});

NodeTest.test("nested and symlinked stores cannot overlap production state", (t) => {
  const f = fixture(t);
  const alias = NodePath.join(f.root, "alias");
  NodeFS.symlinkSync(f.home, alias);
  NodeAssert.throws(
    () => assertSeparatePaths([f.home, NodePath.join(alias, "promotions")]),
    /separate/,
  );
  NodeAssert.doesNotThrow(() => assertSeparatePaths([f.store, f.home, f.profile, f.app]));
});

NodeTest.test("busy checks fail closed on inspection errors and open state files", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () => assertStopped(f.app, [], () => `12 ${f.app}/Contents/MacOS/test`),
    /still running/,
  );
  NodeAssert.throws(
    () =>
      assertStopped(
        f.app,
        [f.home],
        () => "",
        () => ({ status: 1, stdout: "", stderr: "permission denied" }),
      ),
    /Could not verify/,
  );
  NodeAssert.throws(
    () =>
      assertStopped(
        f.app,
        [f.home],
        () => "",
        () => ({ status: 0, stdout: "123\n", stderr: "" }),
      ),
    /still have files open/,
  );
  NodeAssert.doesNotThrow(() =>
    assertStopped(
      f.app,
      [f.home],
      () => "",
      () => ({ status: 1, stdout: "", stderr: "" }),
    ),
  );
});

NodeTest.test("bundle digest covers executable permissions and symlink targets", (t) => {
  const f = fixture(t);
  const before = treeDigest(f.app);
  NodeFS.chmodSync(NodePath.join(f.app, "version"), 0o755);
  NodeAssert.notEqual(treeDigest(f.app), before);
  NodeFS.symlinkSync("version", NodePath.join(f.app, "link"));
  const linked = treeDigest(f.app);
  NodeFS.unlinkSync(NodePath.join(f.app, "link"));
  NodeFS.symlinkSync("elsewhere", NodePath.join(f.app, "link"));
  NodeAssert.notEqual(treeDigest(f.app), linked);
});

NodeTest.test("commands capture repository listings larger than the default output buffer", () => {
  const output = run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
  NodeAssert.equal(output.length, 2 * 1024 * 1024);
});

NodeTest.test("source identity includes uncommitted and untracked source edits", (t) => {
  const f = fixture(t);
  const project = NodePath.join(f.root, "repo");
  NodeFS.mkdirSync(project);
  const git = (args) => run("git", args, { cwd: project });
  git(["init"]);
  NodeFS.writeFileSync(NodePath.join(project, "tracked"), "initial");
  git(["add", "tracked"]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const initial = sourceIdentity(project);
  NodeFS.writeFileSync(NodePath.join(project, "tracked"), "modified");
  const modified = sourceIdentity(project);
  NodeAssert.notEqual(modified.digest, initial.digest);
  NodeAssert.equal(modified.revision, initial.revision);
  NodeFS.writeFileSync(NodePath.join(project, "untracked"), "new");
  NodeAssert.notEqual(sourceIdentity(project).digest, modified.digest);
  git(["update-index", "--add", "--cacheinfo", `160000,${initial.revision},vendor`]);
  NodeFS.mkdirSync(NodePath.join(project, "vendor"));
  const submodule = sourceIdentity(project);
  NodeFS.writeFileSync(NodePath.join(project, "vendor", "source"), "changed");
  NodeAssert.notEqual(sourceIdentity(project).digest, submodule.digest);
});

NodeTest.test("same migration IDs with different names are incompatible", () => {
  NodeAssert.throws(
    () => assertRollbackCompatible([{ id: 43, name: "a" }], [{ id: 43, name: "b" }]),
    /migrations changed/,
  );
});

NodeTest.test("reopening uses the recorded production home after installation", (t) => {
  const f = fixture(t);
  const launches = [];
  install(f.store, f.values, false, {
    ...f.operations,
    launch: (app, home) => launches.push({ app, home }),
  });
  NodeAssert.deepEqual(launches, [{ app: f.app, home: f.home }]);
});

NodeTest.test("launch failure retains the successful install and recovery information", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () =>
      install(f.store, f.values, false, {
        ...f.operations,
        launch: () => {
          throw new Error("launch failed");
        },
      }),
    /replacement succeeded/,
  );
  const journal = JSON.parse(
    NodeFS.readFileSync(NodePath.join(f.store, "installation.json"), "utf8"),
  );
  NodeAssert.equal(journal.phase, "installed");
  NodeAssert.equal(NodeFS.existsSync(journal.backup), true);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "new");
});

NodeTest.test("no-launch leaves the verified replacement closed", (t) => {
  const f = fixture(t);
  install(f.store, { ...f.values, "no-launch": true }, false, {
    ...f.operations,
    launch: () => {
      throw new Error("must not launch");
    },
  });
});

NodeTest.test("backup failure leaves the installed app untouched", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () =>
      install(f.store, f.values, false, {
        ...f.operations,
        copy: (source, target) => {
          if (source === f.home) throw new Error("backup failed");
          f.operations.copy(source, target);
        },
      }),
    /backup failed/,
  );
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(f.app, "version"), "utf8"), "old");
});

NodeTest.test("another update after promotion prevents rollback", (t) => {
  const f = fixture(t);
  install(f.store, f.values, false, f.operations);
  NodeFS.writeFileSync(NodePath.join(f.app, "version"), "another version");
  NodeAssert.throws(() => install(f.store, {}, true, f.operations), /Installed app changed/);
});
