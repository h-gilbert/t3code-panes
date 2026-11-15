import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { captureAndroidScreenshot, capturePhysicalScreenshot } from "./PhysicalDeviceScreenshot.ts";

const output = (code: number, stdout: string): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const device = {
  hostId: "local",
  id: "samsung-usb",
  name: "Tablet",
  platform: "android" as const,
  version: "9",
  booted: true,
  physical: true,
};
it.effect("decodes physical Android PNG bytes without requiring an automation session", () =>
  Effect.gen(function* () {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const capture = yield* captureAndroidScreenshot(
      {
        nodePath: "/node",
        run: (_command, args) => {
          expect(args.at(-1)).toBe(device.id);
          return Effect.succeed({ code: 0, stdout: png.toString("base64"), stderr: "" });
        },
      },
      device,
    );
    expect(Buffer.from(capture.png)).toEqual(png);
  }),
);
it.effect("rejects a command failure or non-PNG output instead of showing a broken image", () =>
  Effect.gen(function* () {
    const failure = yield* captureAndroidScreenshot(
      {
        nodePath: "/node",
        run: () => Effect.succeed({ code: 1, stdout: "", stderr: "device offline" }),
      },
      device,
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({
      operation: "physical Android screenshot",
      reason: "command_failed",
      exitCode: 1,
    });
  }),
);

it.effect.each([
  {
    name: "starts a session and retries when none is open",
    error: "SESSION_NOT_FOUND",
    calls: ["screenshot", "open", "screenshot"],
    ok: true,
  },
  {
    name: "does not retry other agent-device failures",
    error: "DEVICE_IN_USE",
    calls: ["screenshot"],
    ok: false,
  },
])("physical iOS screenshot $name", ({ error, calls, ok }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const seen: Array<string> = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const command = input.args[1]!;
          seen.push(command);
          if (command === "open") return output(0, "{}");
          if (seen.includes("open")) {
            yield* fs.writeFile(input.args[2]!, new Uint8Array([137, 80, 78, 71]));
            return output(0, "{}");
          }
          const stdout = JSON.stringify({ success: false, error: { code: error } });
          return output(1, stdout);
        }).pipe(Effect.orDie),
    });
    const result = yield* capturePhysicalScreenshot(
      { ...device, id: "00008130-UDID", platform: "ios" },
      "/agent-device.mjs",
      ["--session", "t3-test"],
    ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner), Effect.result);
    expect(seen).toEqual(calls);
    expect(result._tag === "Success").toBe(ok);
  }).pipe(Effect.provide(NodeServices.layer)),
);
