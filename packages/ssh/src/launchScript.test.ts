// @effect-diagnostics nodeBuiltinImport:off - runs the generated launch script with a real shell and Node server.
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

import { buildRemoteLaunchScript } from "./tunnel.ts";

const decodeLaunchResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      remotePort: Schema.Int,
      serverKind: Schema.Literals(["external", "managed"]),
    }),
  ),
);

// Stands in for `t3 serve`: answers readiness probes and owns the home's
// runtime record the way a real server does.
const FAKE_SERVER = `
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const record = path.join(args[args.indexOf("--base-dir") + 1], "userdata", "server-runtime.json");
// Written before listening so a ready probe implies the record exists.
fs.mkdirSync(path.dirname(record), { recursive: true });
fs.writeFileSync(record, JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port, startedAt: "" }));
http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1", () => process.send?.("ready"));
process.on("SIGTERM", () => {
  fs.rmSync(record, { force: true });
  process.exit(0);
});
`;

const freeLoopbackPort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    }),
);

it.effect.each(["plain", "quoted", "launchd"] as const)(
  "does not start a competing server while a boot service is down (%s)",
  (kind) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      if (kind === "launchd" && !NodeFS.existsSync("/usr/libexec/PlistBuddy")) return;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-service-gap-"));
      try {
        const unit = NodePath.join(
          home,
          kind === "launchd"
            ? "Library/LaunchAgents/com.t3tools.t3code.service.plist"
            : ".config/systemd/user/t3code.service",
        );
        NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
        const baseDir = NodePath.join(home, ".t3");
        NodeFS.writeFileSync(
          unit,
          kind === "launchd"
            ? `<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>T3CODE_HOME</key><string>${baseDir}</string></dict></dict></plist>`
            : `Environment=T3CODE_HOME=${kind === "quoted" ? JSON.stringify(baseDir) : baseDir}\n`,
        );
        const serverPath = NodePath.join(home, "must-not-start.mjs");
        const marker = NodePath.join(home, "started");
        NodeFS.writeFileSync(
          serverPath,
          `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`,
        );
        const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-key"], {
          input: buildRemoteLaunchScript({ nodeScriptPath: serverPath }),
          env: { HOME: home, PATH: process.env.PATH ?? "" },
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.status, 1);
        assert.include(result.stderr, "background service owns this home");
        assert.isFalse(NodeFS.existsSync(marker));
        assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".t3/ssh-launch/test-key/pid")));
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }),
);

it.effect("reuses the boot service even when stale managed metadata has no PID", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-service-"));
    const serverPath = NodePath.join(home, "fake-server.mjs");
    NodeFS.writeFileSync(serverPath, FAKE_SERVER);
    const port = yield* freeLoopbackPort;
    const stateDir = NodePath.join(home, ".t3", "ssh-launch", "test-key");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stateDir, "managed"), "managed\n");
    const service = NodeChildProcess.spawn(
      process.execPath,
      [serverPath, "--port", String(port), "--base-dir", NodePath.join(home, ".t3")],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = NodeEvents.EventEmitter.once(service, "exit");
    try {
      yield* Effect.promise(() => NodeEvents.EventEmitter.once(service, "message"));
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-key"], {
        input: buildRemoteLaunchScript({ nodeScriptPath: serverPath }),
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(yield* decodeLaunchResult(result.stdout.trim().split("\n").at(-1) ?? ""), {
        remotePort: port,
        serverKind: "external",
      });
      assert.isTrue(isAlive(service.pid!));
      assert.isFalse(NodeFS.existsSync(NodePath.join(stateDir, "pid")));
    } finally {
      service.kill();
      yield* Effect.promise(() => exited);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);

it.effect("refuses to retire a live duplicate and switch to a stale service", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-duplicate-"));
    const serverPath = NodePath.join(home, "fake-server.mjs");
    NodeFS.writeFileSync(serverPath, FAKE_SERVER);
    const stateDir = NodePath.join(home, ".t3", "ssh-launch", "test-key");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const servicePort = yield* freeLoopbackPort;
    const service = NodeChildProcess.spawn(
      process.execPath,
      [serverPath, "--port", String(servicePort), "--base-dir", NodePath.join(home, ".t3")],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = NodeEvents.EventEmitter.once(service, "exit");
    const serviceReady = NodeEvents.EventEmitter.once(service, "message");
    const duplicatePort = yield* freeLoopbackPort;
    const duplicate = NodeChildProcess.spawn(
      process.execPath,
      [serverPath, "--port", String(duplicatePort), "--base-dir", NodePath.join(home, "duplicate")],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const duplicateExited = NodeEvents.EventEmitter.once(duplicate, "exit");
    const duplicateReady = NodeEvents.EventEmitter.once(duplicate, "message");
    try {
      yield* Effect.promise(() => Promise.all([serviceReady, duplicateReady]));
      // Both owners must survive the rejected handover.
      NodeFS.writeFileSync(NodePath.join(stateDir, "pid"), String(duplicate.pid));
      NodeFS.writeFileSync(NodePath.join(stateDir, "managed"), "managed\n");
      NodeFS.writeFileSync(NodePath.join(stateDir, "port"), String(duplicatePort));
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-key"], {
        input: buildRemoteLaunchScript({ nodeScriptPath: serverPath }),
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 1);
      assert.include(result.stderr, "Two T3 servers");
      assert.isTrue(isAlive(service.pid!));
      assert.isTrue(isAlive(duplicate.pid!));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8"),
        String(duplicate.pid),
      );
    } finally {
      service.kill();
      duplicate.kill();
      yield* Effect.promise(() => Promise.all([exited, duplicateExited]));
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.effect("adopts a service that appears while the SSH contender is starting", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-race-"));
    const serverPath = NodePath.join(home, "fake-server.mjs");
    const contenderPath = NodePath.join(home, "contender.mjs");
    const runtimePath = NodePath.join(home, ".t3", "userdata", "server-runtime.json");
    NodeFS.writeFileSync(serverPath, FAKE_SERVER);
    NodeFS.writeFileSync(
      contenderPath,
      `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const record = path.join(process.env.HOME, ".t3", "userdata", "server-runtime.json");
      fs.renameSync(record + ".pending", record);
      process.exit(1);
    `,
    );
    const stateDir = NodePath.join(home, ".t3", "ssh-launch", "test-key");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stateDir, "port"), String(yield* freeLoopbackPort));
    const port = yield* freeLoopbackPort;
    const service = NodeChildProcess.spawn(
      process.execPath,
      [serverPath, "--port", String(port), "--base-dir", NodePath.join(home, ".t3")],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = NodeEvents.EventEmitter.once(service, "exit");
    try {
      yield* Effect.promise(() => NodeEvents.EventEmitter.once(service, "message"));
      NodeFS.renameSync(runtimePath, runtimePath + ".pending");
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-key"], {
        // The contender deterministically exits without listening. Only shorten
        // the production readiness deadline; no sleep coordinates the race.
        input: buildRemoteLaunchScript({ nodeScriptPath: contenderPath }).replaceAll(
          'wait_ready "60000"',
          'wait_ready "1000"',
        ),
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(yield* decodeLaunchResult(result.stdout.trim().split("\n").at(-1) ?? ""), {
        remotePort: port,
        serverKind: "external",
      });
      assert.isTrue(isAlive(service.pid!));
      assert.isFalse(NodeFS.existsSync(NodePath.join(stateDir, "pid")));
    } finally {
      service.kill();
      yield* Effect.promise(() => exited);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);

it.effect(
  "reconnecting keeps the managed server that owns the home's runtime record",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-"));
      const serverPath = NodePath.join(home, "fake-server.mjs");
      NodeFS.writeFileSync(serverPath, FAKE_SERVER);
      const stateDir = NodePath.join(home, ".t3", "ssh-launch", "test-key");
      // A boot service for another home must not prevent an SSH-owned server.
      const unit = NodePath.join(home, ".config/systemd/user/t3code.service");
      NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
      NodeFS.writeFileSync(unit, `Environment=T3CODE_HOME=${NodePath.join(home, "other")}\n`);
      // Seed the launcher's preferred port with a free one so the script
      // never probes a real T3 server on the default port.
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(stateDir, "port"), String(yield* freeLoopbackPort));
      const launchedPids = new Set<number>();
      const launch = () => {
        const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-key"], {
          input: buildRemoteLaunchScript({ nodeScriptPath: serverPath }),
          env: { HOME: home, PATH: process.env.PATH ?? "" },
          encoding: "utf8",
          timeout: 30_000,
        });
        const pid = Number(NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8"));
        launchedPids.add(pid);
        assert.equal(result.status, 0, result.stderr);
        return { pid, launch: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") };
      };
      try {
        const first = launch();
        const second = launch();

        assert.equal(second.pid, first.pid);
        assert.isTrue(isAlive(first.pid));
        assert.deepEqual(second.launch, first.launch);
        assert.equal(first.launch.serverKind, "managed");
      } finally {
        for (const pid of launchedPids) {
          if (isAlive(pid)) process.kill(pid);
        }
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }),
  60_000,
);
