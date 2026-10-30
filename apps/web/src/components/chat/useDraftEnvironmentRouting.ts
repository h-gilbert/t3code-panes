import {
  getAutomaticRemoteProjectDestination,
  getRemoteProjectDraftContext,
} from "../../remoteProjectProvisioning";
import type { Project } from "../../types";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { newProjectId } from "~/lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { DraftSessionState } from "../../composerDraftStore";

interface DraftEnvironmentRoutingInput {
  readonly embeddedPane: boolean;
  readonly activeProject: Project | null;
  readonly activeProjectSettings: ResolvedProjectSettings;
  readonly composerEnvironmentOptions: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    embeddedPane,
    activeProject,
    activeProjectSettings,
    composerEnvironmentOptions,
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const environments = [...environmentById.values()];
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = needsLoadBalancing
    ? logicalProjectEnvironments
        .filter((candidate) => {
          if (candidate.projectId === null) return false;
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the current change scope into a ref that async environment switches compare against
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons an in-flight environment change when the draft or project scope changes or unmounts
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = composerEnvironmentOptions.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target || target.disabledReason) return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          ...getRemoteProjectDraftContext({
            embeddedPane,
            requestedMode:
              draftThread?.envMode ??
              activeProjectSettings.settings.defaultThreadEnvMode ??
              "local",
          }),
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    const prepare = async () => {
      if (activeProjectIsScratch) {
        const project = await openScratchProject(target.environmentId, "Could not switch machine");
        if (project) retarget(project);
        return;
      }
      const remoteUrl = activeProject?.repositoryIdentity?.locator.remoteUrl;
      const targetEnvironment = environments.find(
        (environment) => environment.environmentId === nextEnvironmentId,
      );
      if (!activeProject || !remoteUrl || !targetEnvironment) return;
      const baseDirectory =
        targetEnvironment.serverConfig?.settings.addProjectBaseDirectory?.trim();
      if (!baseDirectory) {
        toastManager.add({
          type: "error",
          title: `Choose a workspace location for ${target.label}`,
          description:
            'Set "Add project starts in" for this computer in Settings before preparing remote projects.',
        });
        return;
      }
      const destinationPath = getAutomaticRemoteProjectDestination({
        baseDirectory,
        owner: activeProject.repositoryIdentity?.owner,
        remoteUrl,
        workspaceRoot: activeProject.workspaceRoot,
      });
      const cloneResult = await cloneRepository({
        environmentId: nextEnvironmentId,
        input: { remoteUrl, destinationPath },
      });
      if (cloneResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(cloneResult)) throw squashAtomCommandFailure(cloneResult);
        return;
      }
      const projectId = newProjectId();
      const created = await createProject({
        environmentId: nextEnvironmentId,
        input: {
          projectId,
          title: activeProject.title,
          workspaceRoot: cloneResult.value.cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
        },
      });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created)) throw squashAtomCommandFailure(created);
        return;
      }
      retarget({
        ...activeProject,
        environmentId: nextEnvironmentId,
        id: projectId,
        workspaceRoot: cloneResult.value.cwd,
      });
      toastManager.add({
        type: "success",
        title: `Ready on ${target.label}`,
        description: `${activeProject.title} was cloned to ${cloneResult.value.cwd}.`,
      });
    };
    void prepare()
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: `Could not prepare ${target.label}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    provisioningEnvironmentId: busyEnvironmentChange?.environmentId ?? null,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
