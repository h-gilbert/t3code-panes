// @effect-diagnostics nodeBuiltinImport:off - runs the generated launch script with a real shell and Node server.
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildRemoteLaunchScript } from "./tunnel.ts";

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
http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1");
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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.effect(
  "reconnecting keeps the managed server that owns the home's runtime record",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-"));
      const serverPath = NodePath.join(home, "fake-server.mjs");
      NodeFS.writeFileSync(serverPath, FAKE_SERVER);
      const stateDir = NodePath.join(home, ".t3", "ssh-launch", "test-key");
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
