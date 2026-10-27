import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { listPhysicalDevices } from "./PhysicalDevices.ts";

it.effect("discovers USB and paired wireless phones without emulator tools", () =>
  Effect.gen(function* () {
    const result = yield* listPhysicalDevices((command, args) =>
      Effect.succeed({
        code: 0,
        stderr: "",
        stdout:
          command === "xcrun"
            ? JSON.stringify([
                {
                  identifier: "iphone-usb",
                  name: "Phone",
                  simulator: false,
                  available: true,
                  platform: "com.apple.platform.iphoneos",
                  operatingSystemVersion: "27.0.1 (build)",
                  interface: "usb",
                },
                {
                  identifier: "ipad-wifi",
                  name: "Tablet",
                  simulator: false,
                  available: true,
                  platform: "com.apple.platform.iphoneos",
                  operatingSystemVersion: "18.3",
                  interface: "network",
                },
                {
                  identifier: "mac",
                  name: "Mac",
                  simulator: false,
                  available: true,
                  platform: "com.apple.platform.macosx",
                  operatingSystemVersion: "27",
                },
              ])
            : args[0] === "devices"
              ? "List of devices attached\nc142 device model:SM_T380\n192.0.2.1:5555 device model:Pixel_9\nemulator-5554 device model:virtual\nuntrusted unauthorized\noffline offline\n"
              : "[ro.product.model]: [Samsung Tablet]\n[ro.build.version.release]: [9]\n",
      }),
    );
    expect(result.devices.map((device) => device.id)).toEqual([
      "c142",
      "192.0.2.1:5555",
      "iphone-usb",
      "ipad-wifi",
    ]);
    expect(result.devices[0]).toMatchObject({
      name: "Samsung Tablet",
      version: "Android 9",
      physical: true,
      booted: true,
    });
    expect(result.detail).toContain("untrusted is unauthorized");
    expect(result.detail).toContain("Accept its USB debugging trust prompt");
    expect(result.detail).toContain("offline is offline");
  }),
);

it.effect("keeps Android hardware available when Apple tools are absent", () =>
  Effect.gen(function* () {
    const result = yield* listPhysicalDevices((command, args) =>
      Effect.succeed({
        code: command === "xcrun" ? 127 : 0,
        stderr: "",
        stdout:
          args[0] === "devices" ? "List of devices attached\nsamsung device model:SM_T380\n" : "",
      }),
    );
    expect(result.devices).toEqual([
      {
        id: "samsung",
        name: "SM T380",
        version: "Android",
        platform: "android",
        booted: true,
        physical: true,
      },
    ]);
  }),
);
