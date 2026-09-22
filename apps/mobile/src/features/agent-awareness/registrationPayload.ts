import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

import { supportsAgentAwarenessPush } from "./capabilities";

// One alert policy feeds both T3 Connect and direct self-hosted APNs
// registrations. Only states that need attention interrupt the user.
export const AGENT_NOTIFICATION_POLICY = {
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: false,
  notifyOnFailure: true,
} as const satisfies Pick<
  RelayDeviceRegistrationRequest["preferences"],
  "notifyOnApproval" | "notifyOnInput" | "notifyOnCompletion" | "notifyOnFailure"
>;

// Development builds are Xcode-signed and receive sandbox APNs tokens;
// preview and production builds are distribution-signed and use production
// APNs. The relay routes each device's pushes accordingly.
export function resolveApsEnvironment(appVariant: unknown): "sandbox" | "production" {
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeRelayDeviceRegistrationRequest(
  input: {
    readonly deviceId: string;
    readonly label: string;
    readonly appVersion?: string;
    readonly bundleId?: string;
    readonly apsEnvironment?: "sandbox" | "production";
    readonly pushToken?: string;
    readonly notificationsEnabled: boolean;
  } & (
    | { readonly platform?: "ios"; readonly iosMajorVersion: number }
    | { readonly platform: "android"; readonly androidApiLevel: number }
  ),
): RelayDeviceRegistrationRequest {
  const pushAvailable = supportsAgentAwarenessPush();
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: input.platform ?? "ios",
    ...(input.platform === "android"
      ? { androidApiLevel: input.androidApiLevel }
      : { iosMajorVersion: input.iosMajorVersion }),
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    preferences: {
      liveActivitiesEnabled: false,
      notificationsEnabled: pushAvailable && input.notificationsEnabled,
      ...AGENT_NOTIFICATION_POLICY,
    },
  };
}
