import { useCurrentThreadTarget } from "./useCurrentThreadTarget";
import {
  DEFAULT_WORKSPACE_KEY,
  isWorkspacePath,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
} from "../workspacePaneStore";

import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef, type ThreadId } from "@t3tools/contracts";
import { useLocation, useRouter } from "@tanstack/react-router";

import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { usePrimaryEnvironmentId } from "../state/environments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { toastManager } from "../components/ui/toast";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
  };
}

export function useNewThreadHandler() {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    if (isWorkspacePath(router.state.location.pathname)) {
      const workspace = router.state.location.search.workspace ?? DEFAULT_WORKSPACE_KEY;
      const layout = selectProjectWorkspaceLayout(useWorkspacePaneStore.getState(), workspace);
      const target = layout.panes[layout.focusedPaneIndex];
      if (target)
        return "draftId" in target
          ? { kind: "draft" as const, draftId: target.draftId }
          : { kind: "server" as const, threadRef: target };
    }
    return resolveThreadRouteTarget(currentRouteParams);
  };

  return (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      replace?: boolean;
      navigate?: boolean;
      freshDraft?: { draftId: DraftId; threadId: ThreadId };
      carryComposerContent?: boolean;
    },
  ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
    const projects = readProjects();
    // Read at call time: every provider status push replaces the config map, and
    // subscribing would hand every sidebar row a new handler.
    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const targetServerSettings =
      environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const {
      getComposerDraft,
      moveComposerPromptAndImages,
      getDraftSessionByLogicalProjectKey,
      getDraftSession,
      getDraftThread,
      applyStickyState,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
      setModelSelection,
    } = useComposerDraftStore.getState();
    const requestingRouteHref = router.state.location.href;
    const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
    const currentRouteTarget = getCurrentRouteTarget();
    const carrySourceShell =
      currentRouteTarget?.kind === "server" ? readThreadShell(currentRouteTarget.threadRef) : null;
    const carrySourceDraft =
      currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
    const carrySourceComposer = currentRouteTarget
      ? getComposerDraft(
          currentRouteTarget.kind === "server"
            ? currentRouteTarget.threadRef
            : currentRouteTarget.draftId,
        )
      : null;
    const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
    const composerModelSelection = composerActiveProvider
      ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
      : null;
    const carryModelSelection = composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
    const carryInteractionMode =
      carrySourceComposer?.interactionMode ??
      carrySourceShell?.interactionMode ??
      carrySourceDraft?.interactionMode ??
      null;
    // Content only moves when the caller opted in and the user is looking
    // at a draft. The content check happens at move time, not here: the
    // paths below await, and text typed during those awaits must still
    // come along.
    const carryContentSourceDraftId =
      options?.carryComposerContent === true && currentRouteTarget?.kind === "draft"
        ? currentRouteTarget.draftId
        : null;
    const carryComposerContentTo = (destinationDraftId: DraftId) => {
      if (
        carryContentSourceDraftId &&
        carryContentSourceDraftId !== destinationDraftId &&
        // Never clobber a destination the user already invested in — the
        // move overwrites the destination prompt, so a concurrent repo
        // change that carried content first must win.
        !composerDraftHasUserContent(getComposerDraft(destinationDraftId)) &&
        composerDraftHasUserContent(getComposerDraft(carryContentSourceDraftId))
      ) {
        moveComposerPromptAndImages(carryContentSourceDraftId, destinationDraftId);
        // The move caps at the destination's free slots and skips
        // duplicates, so images and files can both stay behind.
        const remainingDraft = getComposerDraft(carryContentSourceDraftId);
        const remainingCount =
          (remainingDraft?.files.length ?? 0) + (remainingDraft?.images.length ?? 0);
        if (remainingCount > 0) {
          toastManager.add({
            type: "warning",
            title: `${remainingCount} attachment${remainingCount === 1 ? " stayed" : "s stayed"} in the original draft`,
            description: "Return to the original draft or attach the files again.",
          });
        }
      }
    };
    const project = projects.find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    );
    const abandonedSinceRequest = () =>
      routeChangedSinceRequest() || (project !== undefined && readProject(projectRef) === null);
    const projectSettings = resolveProjectSettings(
      targetServerSettings,
      project?.id ?? null,
      project,
    );
    const projectDefaultModelSelection =
      targetServerSettings.starredModelSelection ?? projectSettings.settings.defaultModelSelection;
    const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
    const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: projectDefaultModelSelection ?? null,
        carrySelection: carryModelSelection,
        carrySourceDraftId:
          currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
        destinationDraftId,
      });
    const applyDefaultModel = (targetDraftId: DraftId) => {
      if (hasExplicitComposerModelSelection(getComposerDraft(targetDraftId))) return;
      applyStickyState(targetDraftId);
      const selection = resolveModelSelectionOverride(targetDraftId);
      if (selection) setModelSelection(targetDraftId, selection, { replaceOptions: true });
    };
    const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
      const consultProjectFile =
        project !== undefined && projectSettings.settings.defaultThreadEnvMode === null;
      const projectFile = consultProjectFile
        ? await readT3ProjectFile(project.environmentId, project.workspaceRoot)
        : null;
      return resolveNewThreadEnvMode({
        projectSettings: resolveProjectSettings(
          targetServerSettings,
          project?.id ?? null,
          project,
          projectFile,
        ),
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
        projectHasThreads: readThreadShells().some(
          (thread) =>
            thread.environmentId === projectRef.environmentId &&
            thread.projectId === projectRef.projectId,
        ),
      });
    };
    const logicalProjectKey = project
      ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
      : scopedProjectKey(projectRef);
    const requestedFreshDraft = options?.freshDraft;
    const existingRequestedDraft = requestedFreshDraft
      ? getDraftSession(requestedFreshDraft.draftId)
      : null;
    if (
      existingRequestedDraft?.logicalProjectKey === logicalProjectKey &&
      existingRequestedDraft.promotedTo === null
    ) {
      return Promise.resolve({
        draftId: requestedFreshDraft!.draftId,
        threadId: existingRequestedDraft.threadId,
      });
    }
    const hasBranchOption = options?.branch !== undefined;
    const hasWorktreePathOption = options?.worktreePath !== undefined;
    const hasEnvModeOption = options?.envMode !== undefined;
    const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
    const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    const storedDraftThreadRef = storedDraftThread
      ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
      : null;
    const reusableStoredDraftThread =
      storedDraftThread !== null &&
      storedDraftThread.promotedTo == null &&
      storedDraftThreadRef !== null &&
      readThreadShell(storedDraftThreadRef) === null
        ? storedDraftThread
        : null;
    if (storedDraftThreadRef && reusableStoredDraftThread === null) {
      markPromotedDraftThreadByRef(storedDraftThreadRef);
    }
    const emptyStoredDraftThread =
      !requestedFreshDraft &&
      reusableStoredDraftThread &&
      !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
        ? reusableStoredDraftThread
        : null;
    const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
      ? currentRouteTarget.kind === "server"
        ? getDraftThread(currentRouteTarget.threadRef)
        : getDraftSession(currentRouteTarget.draftId)
      : null;
    if (emptyStoredDraftThread) {
      return (async () => {
        const isDraftAlreadyOpen =
          currentRouteTarget?.kind === "draft" &&
          currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
        const hasExplicitWorkspaceOption =
          hasBranchOption || hasWorktreePathOption || hasEnvModeOption || hasStartFromOriginOption;
        let workspaceContext: NewThreadWorkspaceOptions | null = null;
        if (hasExplicitWorkspaceOption) {
          workspaceContext = pickExplicitWorkspaceOptions(options);
        } else if (!isDraftAlreadyOpen) {
          const defaultEnvMode = await resolveDefaultEnvMode();
          if (abandonedSinceRequest()) {
            return null;
          }
          // If the draft was opened (a concurrent invocation's navigation
          // landed), promoted to a real thread, remapped away (a concurrent
          // invocation registered a fresh draft — remapping back would evict
          // the winner and let the store GC it), or gained content (no longer
          // a reusable empty draft) in the meantime, this invocation is a
          // stale loser: resetting context, remapping, or navigating would
          // all clobber state written after the snapshot above.
          const routeTargetNow = getCurrentRouteTarget();
          const openedMeanwhile =
            routeTargetNow?.kind === "draft" &&
            routeTargetNow.draftId === emptyStoredDraftThread.draftId;
          const promotedMeanwhile =
            storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
          const remappedMeanwhile =
            getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
            emptyStoredDraftThread.draftId;
          const investedMeanwhile = composerDraftHasUserContent(
            getComposerDraft(emptyStoredDraftThread.draftId),
          );
          if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
            return null;
          }
          workspaceContext = {
            branch: null,
            worktreePath: null,
            envMode: defaultEnvMode,
            startFromOrigin: resolveNewDraftStartFromOrigin({
              envMode: defaultEnvMode,
              newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
            }),
          };
        }
        if (workspaceContext) {
          setDraftThreadContext(emptyStoredDraftThread.draftId, {
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
          });
        }
        applyDefaultModel(emptyStoredDraftThread.draftId);
        // The workspace context must also ride along here: when projectRef
        // targets a different physical member of the logical project,
        // createDraftThreadState treats the remap as a project change and
        // would otherwise wipe branch/worktree, undoing the write above.
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          projectRef,
          emptyStoredDraftThread.draftId,
          {
            threadId: emptyStoredDraftThread.threadId,
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
          },
        );
        const opened = {
          draftId: emptyStoredDraftThread.draftId,
          threadId: emptyStoredDraftThread.threadId,
        };
        const routeTargetAfterWrites = getCurrentRouteTarget();
        if (
          routeTargetAfterWrites?.kind === "draft" &&
          routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
        ) {
          carryComposerContentTo(opened.draftId);
          return opened;
        }
        if (options?.navigate !== false) {
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
        }
        carryComposerContentTo(opened.draftId);
        return opened;
      })();
    }

    if (
      !requestedFreshDraft &&
      latestActiveDraftThread &&
      currentRouteTarget?.kind === "draft" &&
      latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
      latestActiveDraftThread.promotedTo == null &&
      !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
    ) {
      if (
        hasBranchOption ||
        hasWorktreePathOption ||
        hasEnvModeOption ||
        hasStartFromOriginOption
      ) {
        setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
        threadId: latestActiveDraftThread.threadId,
        createdAt: latestActiveDraftThread.createdAt,
        runtimeMode: latestActiveDraftThread.runtimeMode,
        interactionMode: latestActiveDraftThread.interactionMode,
        ...pickExplicitWorkspaceOptions(options),
      });
      applyDefaultModel(currentRouteTarget.draftId);
      carryComposerContentTo(currentRouteTarget.draftId);
      return Promise.resolve({
        draftId: currentRouteTarget.draftId,
        threadId: latestActiveDraftThread.threadId,
      });
    }

    const draftId = requestedFreshDraft?.draftId ?? newDraftId();
    const threadId = requestedFreshDraft?.threadId ?? newThreadId();
    const createdAt = new Date().toISOString();
    return (async () => {
      const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
      if (abandonedSinceRequest()) {
        return null;
      }
      // The await yields, so a concurrent invocation may have registered a
      // draft for this logical project in the meantime. Registering ours
      // too would evict that draft while its navigation is in flight —
      // reuse the winner instead, like the synchronous path above does.
      const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (
        !requestedFreshDraft &&
        racedDraft &&
        racedDraft.draftId !== storedDraftThread?.draftId &&
        readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
      ) {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
          threadId: racedDraft.threadId,
          createdAt: racedDraft.createdAt,
          runtimeMode: racedDraft.runtimeMode,
          interactionMode: racedDraft.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        if (options?.navigate !== false) {
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
        }
        applyDefaultModel(racedDraft.draftId);
        carryComposerContentTo(racedDraft.draftId);
        return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        preservePreviousDraft: requestedFreshDraft !== undefined,
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: initialEnvMode,
        startFromOrigin:
          options?.startFromOrigin ??
          resolveNewDraftStartFromOrigin({
            envMode: initialEnvMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        runtimeMode: defaultRuntimeMode,
        ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
      });
      applyDefaultModel(draftId);
      if (options?.navigate !== false) {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
      }
      carryComposerContentTo(draftId);
      return { draftId, threadId };
    })();
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const location = useLocation();
  const focusedProjectKey = useWorkspacePaneStore((state) => {
    if (!isWorkspacePath(location.pathname)) return null;
    const layout = selectProjectWorkspaceLayout(
      state,
      location.search.workspace ?? DEFAULT_WORKSPACE_KEY,
    );
    return layout.projectKeys[layout.focusedPaneIndex] ?? null;
  });
  const routeTarget = useCurrentThreadTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = (() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  })();
  const paneProject =
    focusedProjectKey === null
      ? undefined
      : orderedProjects.find(
          (project) =>
            deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) ===
            focusedProjectKey,
        );
  const contextualEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? paneProject?.environmentId;
  const contextualProjectId =
    activeThread?.projectId ?? activeDraftThread?.projectId ?? paneProject?.id;
  const preferredProjectRef = (() => {
    if (!contextualEnvironmentId || !contextualProjectId) return null;
    const contextualProjectRef = scopeProjectRef(contextualEnvironmentId, contextualProjectId);
    const contextualProject = projects.find(
      (project) =>
        project.environmentId === contextualEnvironmentId && project.id === contextualProjectId,
    );
    if (!contextualProject || !primaryEnvironmentId) return contextualProjectRef;
    const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
      contextualProject,
      projectGroupingSettings,
    );
    const localProject = projects.find(
      (project) =>
        project.environmentId === primaryEnvironmentId &&
        deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) === logicalProjectKey,
    );
    return localProject
      ? scopeProjectRef(localProject.environmentId, localProject.id)
      : contextualProjectRef;
  })();
  const defaultProject =
    orderedProjects.find((project) => project.environmentId === primaryEnvironmentId) ??
    orderedProjects[0];
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    preferredProjectRef,
    defaultProjectRef: defaultProject
      ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
