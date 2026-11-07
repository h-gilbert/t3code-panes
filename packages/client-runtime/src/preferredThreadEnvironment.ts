import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "./state/models.ts";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "./state/projectGrouping.ts";

export function canStartThreadOnEnvironment(
  config: Pick<ServerConfig, "settings" | "providers"> | undefined,
  connected: boolean,
  projectId: ProjectId | null,
  selection?: ModelSelection | null,
  project?: EnvironmentProject,
): boolean {
  if (!connected || !config) return false;
  const model =
    selection ??
    resolveNewThreadModelSelection({
      defaultSelection:
        config.settings.starredModelSelection ??
        resolveProjectSettings(config.settings, projectId, project).settings.defaultModelSelection,
      fallbackSelection: config.settings.fallbackModelSelection,
      providers: config.providers,
      settings: config.settings,
      projectId,
      now: Effect.runSync(Clock.currentTimeMillis),
    }).selection;
  return config.providers.some(
    (provider) =>
      (!model || provider.instanceId === model.instanceId) &&
      resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId) &&
      provider.installed &&
      provider.status !== "error" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable" &&
      (!model || provider.models.some((candidate) => candidate.slug === model.model)),
  );
}

export function preferredThreadProject(input: {
  readonly project: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly preferredEnvironmentId: string | null | undefined;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings" | "providers">>;
  readonly grouping: ProjectGroupingSettings;
  readonly selection?: ModelSelection | null;
  readonly pinned?: boolean;
}): EnvironmentProject {
  if (input.pinned || !input.preferredEnvironmentId) return input.project;
  const logicalKey = deriveLogicalProjectKeyFromSettings(input.project, input.grouping);
  return (
    input.projects.find(
      (candidate) =>
        candidate.environmentId === input.preferredEnvironmentId &&
        candidate.archivedAt == null &&
        deriveLogicalProjectKeyFromSettings(candidate, input.grouping) === logicalKey &&
        canStartThreadOnEnvironment(
          input.serverConfigs.get(candidate.environmentId),
          input.connectedEnvironmentIds.has(candidate.environmentId),
          candidate.id,
          input.selection,
          candidate,
        ),
    ) ?? input.project
  );
}
