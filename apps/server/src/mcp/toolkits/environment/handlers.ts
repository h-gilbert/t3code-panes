import {
  OrchestratorMcpFailure,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as AgentSettings from "../../../settings/AgentSettings.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    enableAgentDeviceAccess,
    enableDeviceSupport,
    enableAgentBrowserAccess,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    enableAgentDeviceAccess,
    enableDeviceSupport,
    enableAgentBrowserAccess,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
const update = Effect.fn("EnvironmentTools.update")(function* (input: {
  readonly reason: string;
  readonly patch: ServerSettingsPatch;
}) {
  const { scope, caller } = yield* access;
  yield* McpInvocationContext.requireThreadScope(scope, "Changing settings");
  if (!caller?.activeRunId) {
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "Changing settings requires a live T3 thread.",
    });
  }
  const service = yield* AgentSettings.AgentSettings;
  return yield* service.update({ ...input, threadId: caller.id, runId: caller.activeRunId });
});

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  // Takes a linked-environment target, so it needs a remote check; approval stays in `update`.
  t3_environment_preferences_update: McpToolAccess.writesWithCapability(
    ({ reason, ...patch }) => update({ reason, patch }),
  ),
  t3_settings_update: McpToolAccess.actsAsCaller(update),
});
