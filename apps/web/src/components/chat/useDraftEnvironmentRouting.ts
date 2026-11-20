import { msg, useGT } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import {
  getAutomaticRemoteProjectDestination,
  getRemoteProjectDraftContext,
} from "../../remoteProjectProvisioning";
import type { Project } from "../../types";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { newProjectId } from "~/lib/utils";
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
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTriagePrompt, replaceTriagePlaybookLink } from "@t3tools/shared/triagePrompt";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { currentClientMetadata } from "../../connection/platform";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { DraftSessionState } from "../../composerDraftStore";
import { loadBalancingSendWarning } from "./composerSend.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { seedDraftModelSelection } from "../../lib/seedDraftModelSelection";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

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

// Multiple-model selections are kept per route, so a draft moving machine takes them along.
function carryFanoutSelections(
  draft: Pick<DraftSessionState, "environmentId" | "threadId">,
  environmentId: EnvironmentId,
) {
  if (draft.environmentId === environmentId) return;
  const selectionsOn = (id: EnvironmentId) =>
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(id, draft.threadId)));
  appAtomRegistry.set(
    selectionsOn(environmentId),
    appAtomRegistry.get(selectionsOn(draft.environmentId)),
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine. A triage draft takes its session along: the
 * target machine prepares one, and the playbook link follows.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const gt = useGT();
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
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prepareTriage = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = automaticEnvironment
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
    needsLoadBalancing ? loadBalancingCandidates : [],
    loadBalancingSettings.loadBalancingWeights,
  );
  const readRouting = useStableCallback(() => ({ input, loadBalancingCandidates }));
  const refreshBeforeSend = () => {
    if (
      !automaticEnvironment ||
      !draftId ||
      !draftThread?.loadBalancedEnvironmentId ||
      draftThread.promotedTo ||
      composerHasAttachments
    )
      return null;
    const originalDraft = getDraftSession(draftId);
    const composerDraft = useComposerDraftStore.getState().getComposerDraft(draftId);
    return loadBalancing.refreshSelection(loadBalancingCandidates).then((environmentId) => {
      const current = readRouting();
      if (
        current.input.draftId !== draftId ||
        !current.input.automaticEnvironment ||
        current.input.composerHasAttachments ||
        current.input.activeProjectKey !== activeProjectKey ||
        current.input.selectedProvider !== selectedProvider ||
        current.input.activeProviderInstanceId !== activeProviderInstanceId ||
        current.input.loadBalancingSettings.loadBalancingWeights !==
          loadBalancingSettings.loadBalancingWeights ||
        current.loadBalancingCandidates.join("\n") !== loadBalancingCandidates.join("\n") ||
        getDraftSession(draftId) !== originalDraft ||
        useComposerDraftStore.getState().getComposerDraft(draftId) !== composerDraft
      )
        return false;
      const target = current.input.logicalProjectEnvironments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!target?.projectId) {
        toastManager.add({
          type: "warning",
          ...loadBalancingSendWarning({
            pending: false,
            threadContexts: referencedThreadContexts,
            candidateEnvironmentIds: loadBalancingCandidates,
          }),
        });
        return false;
      }
      const projectRef = scopeProjectRef(target.environmentId, target.projectId);
      if (originalDraft) carryFanoutSelections(originalDraft, target.environmentId);
      // The send must read the target project's composer and provider context after retargeting.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "auto",
          loadBalancedEnvironmentId: target.environmentId,
          ...(embeddedPane && originalDraft?.environmentId !== target.environmentId
            ? getRemoteProjectDraftContext({ embeddedPane: true, requestedMode: "local" })
            : { branch: originalDraft?.branch ?? null }),
        }),
      );
      return true;
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    const draft = getDraftSession(draftId);
    if (draft) carryFanoutSelections(draft, target.environmentId);
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
      ...(embeddedPane && draft?.environmentId !== target.environmentId
        ? getRemoteProjectDraftContext({ embeddedPane: true, requestedMode: "local" })
        : {}),
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    embeddedPane,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: m(msg("Keep attachments on this machine")),
        description: m(
          msg(
            "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
          ),
        ),
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
      ? gt("Auto balance")
      : loadBalancing.pending
        ? gt("Checking machines…")
        : loadBalancing.failed
          ? gt("Auto balance unavailable")
          : gt("Auto balance")
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
    // `triagePrompt` is the prompt the target machine prepared for a triage draft.
    const retarget = (project: (typeof allProjects)[number], triagePrompt?: string) => {
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
      if (triagePrompt !== undefined) {
        // Read now, so text typed while the machine prepared the session is kept.
        const prompt = getComposerDraft(draftId)?.prompt ?? "";
        const nextPrompt = replaceTriagePlaybookLink(prompt, triagePrompt);
        if (nextPrompt !== prompt) setPrompt(draftId, nextPrompt);
      }
      carryFanoutSelections(currentDraft, target.environmentId);
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
      seedDraftModelSelection(draftId, projectRef);
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    const knownProject = allProjects.find(
      (project) =>
        project.environmentId === target.environmentId && project.id === target.projectId,
    );
    // The playbook and context files exist only on the machine that prepared them.
    const followsTriage = isTriagePrompt(getComposerDraft(draftId)?.prompt ?? "");
    if (target.projectId !== null && !followsTriage) {
      if (knownProject) retarget(knownProject);
      finish();
      return;
    }
    const prepareTriagePrompt = async () => {
      const prepared = await prepareTriage({
        environmentId: target.environmentId,
        input: { client: currentClientMetadata() },
      });
      if (prepared._tag === "Success") return prepared.value.prompt;
      if (!isAtomCommandInterrupted(prepared)) {
        const error = squashAtomCommandFailure(prepared);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not switch machine")),
            description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
          }),
        );
      }
      return null;
    };
    const prepareRemoteProject = async () => {
      const remoteUrl = activeProject?.repositoryIdentity?.locator.remoteUrl;
      const targetEnvironment = environmentById.get(nextEnvironmentId);
      if (!activeProject || !remoteUrl || !targetEnvironment) return;
      const baseDirectory =
        targetEnvironment.serverConfig?.settings.addProjectBaseDirectory?.trim();
      if (!baseDirectory) {
        toastManager.add({
          type: "error",
          title: gt("Choose a workspace location for {machine}", { machine: target.label }),
          description: gt(
            'Set "Add project starts in" for this computer in Settings before preparing remote projects.',
          ),
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
      toastManager.add({
        type: "success",
        title: gt("Ready on {machine}", { machine: target.label }),
        description: gt("{project} was cloned to {path}.", {
          project: activeProject.title,
          path: cloneResult.value.cwd,
        }),
      });
      return {
        ...activeProject,
        environmentId: nextEnvironmentId,
        id: projectId,
        workspaceRoot: cloneResult.value.cwd,
      };
    };
    const switchMachine = async () => {
      const triagePrompt = followsTriage ? await prepareTriagePrompt() : undefined;
      if (triagePrompt === null) return;
      const project =
        knownProject ??
        (await (activeProjectIsScratch
          ? openScratchProject(target.environmentId, m(msg("Could not switch machine")))
          : prepareRemoteProject()));
      if (project) retarget(project, triagePrompt);
    };
    setBusyEnvironmentChange(request);
    void switchMachine()
      .catch((error) => {
        if (readPendingEnvironmentChange() !== request) return;
        toastManager.add({
          type: "error",
          title: gt("Could not prepare {machine}", { machine: target.label }),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        });
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    provisioningEnvironmentId: busyEnvironmentChange?.environmentId ?? null,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
