import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { captureAndroidScreenshot } from "./PhysicalDeviceScreenshot.ts";

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
