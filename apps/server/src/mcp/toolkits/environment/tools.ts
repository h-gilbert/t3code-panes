import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentSettings from "../../../settings/AgentSettings.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  enableAgentDeviceAccess: ServerSettings.fields.enableAgentDeviceAccess,
  enableDeviceSupport: ServerSettings.fields.enableDeviceSupport,
  enableAgentBrowserAccess: ServerSettings.fields.enableAgentBrowserAccess,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    AgentSettings.AgentSettings,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Always asks the user to approve the exact changes in T3 Code, even in full access. Requires a live calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    reason: Schema.String,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct({ applied: Schema.Boolean }),
}).annotate(Tool.Destructive, true);
const SettingsUpdateTool = Tool.make("t3_settings_update", {
  ...shared,
  description:
    "Propose changes to this environment's T3 Code settings. Explain the reason and pass a patch using the normal settings schema. T3 shows the exact changes and waits for the user to approve this specific request, including in full access. Rejection changes nothing. Requires a live T3 thread. Omitted fields are preserved. Device/browser access changes may require a new turn to refresh available tools. Never edit the live settings file directly.",
  parameters: Schema.Struct({ reason: Schema.String, patch: ServerSettingsPatch }),
  success: Schema.Struct({ applied: Schema.Boolean }),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  SettingsUpdateTool,
);
