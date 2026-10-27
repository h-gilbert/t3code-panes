import type { DeviceHostReady, HostDevice } from "./DeviceHost.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const AppleDevice = Schema.Struct({
  identifier: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  simulator: Schema.Boolean,
  platform: Schema.String,
  operatingSystemVersion: Schema.String,
});
const decodeAppleDevices = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(AppleDevice)),
);

export const listPhysicalDevices = Effect.fn("PhysicalDevices.list")(function* (
  run: DeviceHostReady["run"],
) {
  const [android, apple] = yield* Effect.all(
    [
      run("adb", ["devices", "-l"], { timeoutMs: 10_000 }),
      run("xcrun", ["xcdevice", "list", "--timeout", "3"], { timeoutMs: 10_000 }),
    ],
    { concurrency: "unbounded" },
  );
  const devices: HostDevice[] = [];
  const details: string[] = [];
  if (android.code === 0) {
    for (const line of android.stdout.split(/\r?\n/)) {
      const match = /^(\S+)\s+(device|unauthorized|offline)\b(.*)$/.exec(line);
      if (!match || match[1]!.startsWith("emulator-")) continue;
      const [, id, status, metadata] = match;
      if (status !== "device") {
        details.push(
          `Android device ${id} is ${status}.${status === "unauthorized" ? " Accept its USB debugging trust prompt." : " Reconnect it before testing."}`,
        );
        continue;
      }
      const properties = yield* run("adb", ["-s", id!, "shell", "getprop"], { timeoutMs: 10_000 });
      const property = (name: string) =>
        properties.stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith(`[${name}]: [`))
          ?.slice(name.length + 5, -1);
      devices.push({
        id: id!,
        name:
          property("ro.product.model") ??
          /\bmodel:(\S+)/.exec(metadata!)?.[1]?.replaceAll("_", " ") ??
          id!,
        platform: "android",
        version: property("ro.build.version.release")
          ? `Android ${property("ro.build.version.release")}`
          : "Android",
        physical: true,
        booted: true,
      });
    }
  }
  if (android.code !== 0 && android.code !== 127)
    details.push(
      `Could not list physical Android devices (exit ${android.code}). ${android.stderr.trim()}`,
    );
  if (apple.code !== 0 && apple.code !== 127)
    details.push(
      `Could not list physical iOS devices (exit ${apple.code}). ${apple.stderr.trim()}`,
    );
  if (apple.code === 0) {
    const listed = yield* decodeAppleDevices(apple.stdout).pipe(Effect.orElseSucceed(() => []));
    for (const device of listed) {
      if (device.simulator || device.platform !== "com.apple.platform.iphoneos") continue;
      if (!device.available) {
        details.push(
          `iOS device ${device.name} is unavailable. Check its connection, trust, and Developer Mode.`,
        );
        continue;
      }
      devices.push({
        id: device.identifier,
        name: device.name,
        platform: "ios",
        version: `iOS ${device.operatingSystemVersion.split(" ")[0]}`,
        booted: true,
        physical: true,
      });
    }
  }
  return { devices, detail: details.join("\n") || undefined };
});
