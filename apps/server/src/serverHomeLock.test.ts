// @effect-diagnostics nodeBuiltinImport:off - verifies OS locks across real processes.
// @effect-diagnostics preferSchemaOverJson:off - quotes trusted literals in a child-process test script.
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import { acquireServerHomeLock } from "./serverHomeLock.ts";
import { persistServerRuntimeState } from "./serverRuntimeState.ts";
import * as ServerConfig from "./config.ts";
import { runServer } from "./server.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-lock-" });
  return { stateDir, serverRuntimeStatePath: path.join(stateDir, "server-runtime.json") };
});

describe("server home ownership", () => {
  it.effect("rejects a second server before opening its conversation database", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* acquireServerHomeLock(config);
      const error = yield* runServer.pipe(Effect.flip);
      assert.equal(error._tag, "ServerHomeLockError");
      assert.isFalse(yield* fs.exists(config.dbPath));
      assert.isFalse(yield* fs.exists(config.serverRuntimeStatePath));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/tmp", { prefix: "t3-home-startup-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
  it.effect(
    "excludes a second startup before either server advertises, then releases on shutdown",
    () =>
      Effect.gen(function* () {
        const config = yield* fixture;
        const owner = yield* Scope.make();
        yield* acquireServerHomeLock(config).pipe(Scope.provide(owner));
        try {
          const error = yield* acquireServerHomeLock(config).pipe(Effect.scoped, Effect.flip);
          assert.equal(error._tag, "ServerHomeLockError");
          // Isolated dev homes can still run concurrently.
          yield* acquireServerHomeLock(yield* fixture);
        } finally {
          yield* Scope.close(owner, Exit.void);
        }
        yield* acquireServerHomeLock(config);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("respects a live older server and releases the lock when startup is rejected", () =>
    Effect.gen(function* () {
      const config = yield* fixture;
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: {
          version: 1,
          pid: process.ppid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-12T19:38:00Z",
          serviceManaged: true,
        },
      });
      const error = yield* acquireServerHomeLock(config).pipe(Effect.scoped, Effect.flip);
      assert.include(error.message, `PID ${process.ppid}`);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(config.serverRuntimeStatePath);
      yield* acquireServerHomeLock(config);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "treats symlinked state directories as the same home and ignores dead runtime records",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const config = yield* fixture;
        const alias = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linkedDir = path.join(alias.stateDir, "linked");
        yield* fs.symlink(config.stateDir, linkedDir);
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: {
            version: 1,
            pid: 2_147_483_646,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-12T19:38:00Z",
          },
        });
        yield* acquireServerHomeLock(config);
        const error = yield* acquireServerHomeLock({
          stateDir: linkedDir,
          serverRuntimeStatePath: path.join(linkedDir, "server-runtime.json"),
        }).pipe(Effect.scoped, Effect.flip);
        assert.equal(error._tag, "ServerHomeLockError");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases ownership after a process is killed without cleanup", () =>
    Effect.gen(function* () {
      const config = yield* fixture;
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
        import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
        import { acquireServerHomeLock } from ${JSON.stringify(new URL("./serverHomeLock.ts", import.meta.url).href)};
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          yield* acquireServerHomeLock(${JSON.stringify(config)});
          yield* Effect.sync(() => process.send("locked"));
          yield* Effect.never;
        })).pipe(Effect.provide(NodeServices.layer)));
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let childError = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        childError += chunk.toString();
      });
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      try {
        const message = yield* Effect.promise(() =>
          Promise.race([
            NodeEvents.EventEmitter.once(child, "message"),
            exited.then(() => {
              throw new Error(`Lock owner exited before acquiring the lock: ${childError}`);
            }),
          ]),
        );
        assert.equal(message[0], "locked");
        const error = yield* acquireServerHomeLock(config).pipe(Effect.scoped, Effect.flip);
        assert.equal(error._tag, "ServerHomeLockError");
      } finally {
        child.kill("SIGKILL");
        yield* Effect.promise(() => exited);
      }
      yield* acquireServerHomeLock(config);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
