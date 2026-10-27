import { DeviceOperationError, type DeviceSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import type { DeviceHostReady } from "./DeviceHost.ts";
import * as ProcessRunner from "../processRunner.ts";

export const capturePhysicalScreenshot = Effect.fn("PhysicalDeviceScreenshot.capture")(
  function* (device: DeviceSummary, entryPath: string, targetArgs: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const node = yield* resolveNodeExecutable("Device automation");
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-capture-" });
    const file = path.join(directory, "screen.png");
    const result = yield* runner.run({
      command: node,
      args: [
        entryPath,
        "screenshot",
        file,
        "--platform",
        device.platform,
        device.platform === "ios" ? "--udid" : "--serial",
        device.id,
        ...targetArgs,
        "--json",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeout: "60 seconds",
    });
    if (result.code !== 0 || result.timedOut)
      return yield* new DeviceOperationError({
        operation: "physical device screenshot",
        reason: "command_failed",
        exitCode: result.timedOut ? 124 : Number(result.code ?? 127),
        cause: result,
      });
    return { device, png: yield* fs.readFile(file) };
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "DeviceOperationError"
      ? cause
      : new DeviceOperationError({
          operation: "physical device screenshot",
          reason: "command_failed",
          cause,
        }),
  ),
);

export const captureAndroidScreenshot = Effect.fn("PhysicalDeviceScreenshot.captureAndroid")(
  function* (ready: Pick<DeviceHostReady, "nodePath" | "run">, device: DeviceSummary) {
    const result = yield* ready.run(
      ready.nodePath,
      [
        "-e",
        `
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("adb", ["-s", process.argv[1], "exec-out", "screencap", "-p"], { maxBuffer: 32 * 1024 * 1024, timeout: 20000 });
    if (result.error || result.status !== 0) { process.stderr.write(result.stderr ?? String(result.error)); process.exit(1); }
    process.stdout.write(result.stdout.toString("base64"));
  `,
        device.id,
      ],
      { timeoutMs: 25_000 },
    );
    const png = Buffer.from(result.stdout.trim(), "base64");
    if (
      result.code !== 0 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      return yield* new DeviceOperationError({
        operation: "physical Android screenshot",
        reason: "command_failed",
        exitCode: result.code,
        cause: result,
      });
    }
    return { device, png };
  },
);
