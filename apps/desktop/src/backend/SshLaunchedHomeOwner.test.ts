import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as SshLaunchedHomeOwner from "./SshLaunchedHomeOwner.ts";

const ownerIn = (input: {
  readonly runtimePid: number;
  readonly launches: ReadonlyArray<{ readonly pid: number; readonly kind: string }>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const stateDir = path.join(baseDir, "userdata");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(stateDir, "server-runtime.json"),
      `{"pid":${input.runtimePid},"port":3773,"origin":"http://127.0.0.1:3773"}`,
    );
    for (const [index, launch] of input.launches.entries()) {
      const dir = path.join(baseDir, "ssh-launch", `key${index}`);
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "pid"), `${launch.pid}\n`);
      yield* fs.writeFileString(path.join(dir, "managed"), `${launch.kind}\n`);
    }
    return yield* SshLaunchedHomeOwner.find({ baseDir, stateDir });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("finds only a live lock owner that an SSH client launched and manages", () =>
  Effect.gen(function* () {
    const live = process.pid;
    assert.deepStrictEqual(
      yield* ownerIn({
        runtimePid: live,
        launches: [
          { pid: 999_999_999, kind: "managed" },
          { pid: live, kind: "managed" },
        ],
      }),
      Option.some(live),
    );
    // A server the client adopted belongs to someone else, such as the background service.
    assert.isTrue(
      Option.isNone(
        yield* ownerIn({ runtimePid: live, launches: [{ pid: live, kind: "external" }] }),
      ),
    );
    assert.isTrue(Option.isNone(yield* ownerIn({ runtimePid: live, launches: [] })));
    assert.isTrue(
      Option.isNone(
        yield* ownerIn({
          runtimePid: 999_999_999,
          launches: [{ pid: 999_999_999, kind: "managed" }],
        }),
      ),
    );
  }),
);
