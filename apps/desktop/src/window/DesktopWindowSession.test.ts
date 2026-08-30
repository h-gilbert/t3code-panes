import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindowSession from "./DesktopWindowSession.ts";

function makeEnvironmentLayer(baseDir: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

const withSession = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopWindowSession.DesktopWindowSession | DesktopEnvironment.DesktopEnvironment
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-window-session-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopWindowSession.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopWindowSession", () => {
  it.effect("loads an empty session when no file exists", () =>
    withSession(
      Effect.gen(function* () {
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        assert.deepEqual(yield* session.load, []);
      }),
    ),
  );

  it.effect("persists ordered workspace windows and removes closed windows", () =>
    withSession(
      Effect.gen(function* () {
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.load;
        yield* session.upsert({
          workspaceId: "main",
          bounds: { x: 20, y: 40, width: 1200, height: 800 },
          isMaximized: false,
        });
        yield* session.upsert({
          workspaceId: "research",
          bounds: { x: 1240, y: 20, width: 900, height: 900 },
          isMaximized: true,
        });
        yield* session.remove("main");

        assert.deepEqual(yield* session.load, [
          {
            workspaceId: "research",
            bounds: { x: 1240, y: 20, width: 900, height: 900 },
            isMaximized: true,
          },
        ]);
      }),
    ),
  );

  it.effect("drops invalid entries without discarding valid workspace windows", () =>
    withSession(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(environment.stateDir, "window-session.json"),
          `{
            "windows": [
              {
                "workspaceId": "main",
                "bounds": { "x": 10, "y": 20, "width": 1200, "height": 800 },
                "isMaximized": false
              },
              {
                "workspaceId": "",
                "bounds": null,
                "isMaximized": false
              },
              {
                "workspaceId": "too-small",
                "bounds": { "x": 0, "y": 0, "width": 100, "height": 100 },
                "isMaximized": true
              }
            ]
          }\n`,
        );

        assert.deepEqual(yield* session.load, [
          {
            workspaceId: "main",
            bounds: { x: 10, y: 20, width: 1200, height: 800 },
            isMaximized: false,
          },
          {
            workspaceId: "too-small",
            bounds: null,
            isMaximized: false,
          },
        ]);
      }),
    ),
  );
});
