import { Platform } from "react-native";
import type { OrchestrationV2CreationSource } from "@t3tools/contracts";
export const mobileCreationSource: OrchestrationV2CreationSource =
  Platform.OS === "ios" ? "ios" : "mobile";
