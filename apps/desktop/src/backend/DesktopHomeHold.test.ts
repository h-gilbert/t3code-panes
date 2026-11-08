import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopHomeHold from "./DesktopHomeHold.ts";

it.effect("a normal quit releases the hold, and an update restart keeps it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const file = path.join(baseDir, "runtime", "desktop-home-hold");

    yield* DesktopHomeHold.hold(baseDir);
    assert.equal(yield* fs.readFileString(file), `${process.pid} 0\n`);
    yield* DesktopHomeHold.release(baseDir);
    assert.isFalse(yield* fs.exists(file));

    yield* DesktopHomeHold.hold(baseDir);
    yield* DesktopHomeHold.holdThroughRestart(baseDir);
    yield* DesktopHomeHold.release(baseDir);
    const [pid, until] = (yield* fs.readFileString(file)).trim().split(" ");
    assert.equal(pid, String(process.pid));
    assert.isAbove(Number(until), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
