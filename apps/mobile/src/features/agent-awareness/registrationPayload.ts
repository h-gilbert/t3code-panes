import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

import { supportsAgentAwarenessPush } from "./capabilities";

// Development builds use sandbox APNs; distribution builds use production APNs.
export function resolveApsEnvironment(appVariant: unknown): "sandbox" | "production" {
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeRelayDeviceRegistrationRequest(input: {
  readonly deviceId: string;
  readonly label: string;
  readonly iosMajorVersion: number;
  readonly appVersion?: string;
  readonly bundleId?: string;
  readonly apsEnvironment?: "sandbox" | "production";
  readonly pushToken?: string;
  readonly notificationsEnabled: boolean;
}): RelayDeviceRegistrationRequest {
  const pushAvailable = supportsAgentAwarenessPush();
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: "ios",
    iosMajorVersion: input.iosMajorVersion,
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    preferences: {
      liveActivitiesEnabled: false,
      notificationsEnabled: pushAvailable && input.notificationsEnabled,
      // The private app pushes only when a thread needs attention or fails.
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: false,
      notifyOnIosCompletion: false,
      notifyOnFailure: true,
    },
  };
}
