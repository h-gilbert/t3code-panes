import { Platform } from "react-native";

import type {
  ExecutionEnvironmentCapabilities,
  OrchestrationV2CreationSource,
} from "@t3tools/contracts";

export const mobileCreationSource: OrchestrationV2CreationSource =
  Platform.OS === "ios" ? "ios" : "mobile";

export function resolveMobileCreationSource(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "iosTurnOrigin"> | null | undefined,
  platform = Platform.OS,
): "ios" | "mobile" {
  // Stock and older servers reject the private iOS origin instead of ignoring it.
  return platform === "ios" && capabilities?.iosTurnOrigin === true ? "ios" : "mobile";
}
