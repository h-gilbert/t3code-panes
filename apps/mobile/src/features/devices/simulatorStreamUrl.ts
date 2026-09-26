import {
  type DeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";

export function simulatorStreamUrl(access: DeviceHubAccess, deviceId: string): string {
  return withDeviceHubQuery(
    `${access.httpBase}/vendor/serve-sim/helper/${encodeURIComponent(deviceId)}/stream.mjpeg`,
    access,
  );
}
