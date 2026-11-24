import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { preferredThreadProject } from "@t3tools/client-runtime/preferred-thread-environment";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
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
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type T3ProjectFile,
  type ThreadId,
} from "@t3tools/contracts";
import { type AnyRouter, useLocation, useRouter } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  resolveGroupDefaultProject,
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShell,
} from "../state/entities";
import {
  draftModelSelectionApplies,
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
  threadHasStarted,
} from "../lib/chatThreadActions";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { peekT3ProjectFile, readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { usePrimaryEnvironmentId } from "../state/environments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { getClientSettings, useClientSettings } from "./useSettings";
import { toastManager } from "../components/ui/toast";
import { getLocalStorageItem, useLocalStorage } from "./useLocalStorage";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { defaultProjectFallbackReadyAtom } from "../state/projects";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";

export const LAST_USED_PROJECT_STORAGE_KEY = "t3code:last-used-project:v1";
export const lastUsedProjectKeySchema = Schema.NullOr(Schema.String);

export function readLastUsedProjectKey(): string | null {
  try {
    return getLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY, lastUsedProjectKeySchema);
  } catch {
    return null;
  }
}

// Drafts that opened before their project's t3.json was read. A send waits for the file's
// workspace default unless the user has already chosen a workspace.
interface ProvisionalWorkspace {
  readonly envMode: DraftThreadEnvMode;
  // A reused draft keeps an earlier "manual" marker; only a switch to manual after opening is a choice.
  readonly openedManual: boolean;
}

const pendingWorkspaceDefaults = new Map<
  DraftId,
  ProvisionalWorkspace & { readonly settled: Promise<void> }
>();

function keepsProvisionalWorkspace(
  draft: DraftSessionState | null,
  provisional: ProvisionalWorkspace,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.envMode === provisional.envMode &&
    draft.worktreePath === null &&
    (provisional.openedManual || draft.environmentSelection !== "manual")
  );
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<void> | null {
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (pending === undefined) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return keepsProvisionalWorkspace(draft, pending) ? pending.settled : null;
}

interface NewThreadWorkspaceOptions {
  environmentSelection?: "manual";
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.environmentSelection
      ? { environmentSelection: options.environmentSelection }
      : {}),
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
  };
}

export function useNewThreadHandler() {
  return createNewThreadHandler(useRouter());
}

export type NewThreadHandler = ReturnType<typeof createNewThreadHandler>;

export function createNewThreadHandler(router: AnyRouter) {
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
      environmentSelection?: "manual";
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      replace?: boolean;
      navigate?: boolean;
      freshDraft?: { draftId: DraftId; threadId: ThreadId };
      carryComposerContent?: boolean;
      /** Composer text for the draft, set before it shows. A draft with user text keeps it. */
      prompt?: string;
    },
  ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
    const projects = readProjects();
    const projectGroupingSettings = selectProjectGroupingSettings(getClientSettings());
    // Read at call time; status pushes replace the config map and would recreate every sidebar handler.
    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const requestedProject = projects.find(
      (candidate) =>
        candidate.environmentId === projectRef.environmentId &&
        candidate.id === projectRef.projectId,
    );
    if (
      requestedProject &&
      environmentServerConfigs.get(projectRef.environmentId)?.settings.preferredThreadEnvironmentId
    ) {
      const stored = useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(
          deriveLogicalProjectKeyFromSettings(requestedProject, projectGroupingSettings),
        );
      const preferred = preferredThreadProject({
        project: requestedProject,
        projects,
        grouping: projectGroupingSettings,
        preferredEnvironmentId: environmentServerConfigs.get(projectRef.environmentId)?.settings
          .preferredThreadEnvironmentId,
        connectedEnvironmentIds: new Set(
          appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
        ),
        serverConfigs: environmentServerConfigs,
        pinned:
          options?.environmentSelection === "manual" ||
          Boolean(options?.branch || options?.worktreePath) ||
          Boolean(!options?.freshDraft && stored && !stored.promotedTo) ||
          options?.carryComposerContent === true,
      });
      projectRef = scopeProjectRef(preferred.environmentId, preferred.id);
    }
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
      setPrompt,
    } = useComposerDraftStore.getState();
    // Never over text the user wrote: a draft can gain some while this awaits.
    const seedPrompt = (draftId: DraftId) => {
      if (options?.prompt === undefined) return;
      if (composerDraftHasUserContent(getComposerDraft(draftId))) return;
      setPrompt(draftId, options.prompt);
    };
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
    const composerActiveProvider = draftModelSelectionApplies(
      carrySourceComposer,
      threadHasStarted(carrySourceShell),
    )
      ? (carrySourceComposer?.activeProvider ?? null)
      : null;
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
            title: m(
              msg(
                "{count, plural, one {# attachment stayed in the original draft} other {# attachments stayed in the original draft}}",
                { count: remainingCount },
              ),
            ),
            description: m(msg("Return to the original draft or attach the files again.")),
          });
        }
      }
    };
    const project = projects.find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    );
    const projectSettings = resolveProjectSettings(
      targetServerSettings,
      project?.id ?? null,
      project,
    );
    const configuredDefaultModelSelection =
      targetServerSettings.starredModelSelection ?? projectSettings.settings.defaultModelSelection;
    const projectDefaultModelSelection = targetServerSettings.fallbackModelSelection
      ? resolveNewThreadModelSelection({
          defaultSelection: configuredDefaultModelSelection ?? null,
          fallbackSelection: targetServerSettings.fallbackModelSelection,
          providers: environmentServerConfigs.get(projectRef.environmentId)?.providers ?? [],
          settings: targetServerSettings,
          projectId: projectRef.projectId,
          now: Date.now(),
        }).selection
      : configuredDefaultModelSelection;
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
    const envModeFor = (projectFile: T3ProjectFile | null): DraftThreadEnvMode =>
      resolveNewThreadEnvMode({
        projectSettings: resolveProjectSettings(
          targetServerSettings,
          project?.id ?? null,
          project,
          projectFile,
        ),
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
        projectHasThreads:
          readThreadShells().some(
            (thread) =>
              thread.environmentId === projectRef.environmentId &&
              thread.projectId === projectRef.projectId,
          ) ||
          readUnloadedThreadCount(
            [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
            [],
          ) > 0,
      });
    const startFromOriginFor = (envMode: DraftThreadEnvMode) =>
      resolveNewDraftStartFromOrigin({
        envMode,
        newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
      });
    // The draft opens without waiting on t3.json: a cold read takes seconds on a loaded host.
    // Its workspace default lands afterwards unless the user picked a workspace or sent first.
    const resolveDefaultEnvMode = () => {
      // Environment queries wait for a connection, so an offline machine's file is never read.
      const consultProjectFile =
        project !== undefined &&
        projectSettings.settings.defaultThreadEnvMode === null &&
        appAtomRegistry
          .get(environmentSummaries.connectedEnvironmentIdsAtom)
          .includes(project.environmentId);
      if (!consultProjectFile) return { envMode: envModeFor(null), applyProjectFile: () => {} };
      const projectFileRead = readT3ProjectFile(project.environmentId, project.workspaceRoot);
      const cachedProjectFile = peekT3ProjectFile(project.environmentId, project.workspaceRoot);
      if (cachedProjectFile !== undefined) {
        return { envMode: envModeFor(cachedProjectFile), applyProjectFile: () => {} };
      }
      const envMode = envModeFor(null);
      const applyProjectFile = (draftId: DraftId) => {
        const provisional: ProvisionalWorkspace = {
          envMode,
          openedManual: getDraftSession(draftId)?.environmentSelection === "manual",
        };
        const settled = projectFileRead
          .then((projectFile) => {
            const fileEnvMode = envModeFor(projectFile);
            const draft = getDraftSession(draftId);
            if (fileEnvMode === envMode || !keepsProvisionalWorkspace(draft, provisional)) return;
            // Commit before a waiting send re-reads the composer's workspace.
            flushSync(() =>
              setDraftThreadContext(draftId, {
                envMode: fileEnvMode,
                ...(draft.startFromOrigin === startFromOriginFor(envMode)
                  ? { startFromOrigin: startFromOriginFor(fileEnvMode) }
                  : {}),
              }),
            );
          })
          .finally(() => {
            if (pendingWorkspaceDefaults.get(draftId)?.settled === settled) {
              pendingWorkspaceDefaults.delete(draftId);
            }
          });
        pendingWorkspaceDefaults.set(draftId, { ...provisional, settled });
      };
      return { envMode, applyProjectFile };
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
        let applyProjectFile: ((draftId: DraftId) => void) | null = null;
        if (hasExplicitWorkspaceOption) {
          workspaceContext = pickExplicitWorkspaceOptions(options);
        } else if (!isDraftAlreadyOpen) {
          const defaultEnvMode = resolveDefaultEnvMode();
          applyProjectFile = defaultEnvMode.applyProjectFile;
          workspaceContext = {
            branch: null,
            worktreePath: null,
            envMode: defaultEnvMode.envMode,
            startFromOrigin: startFromOriginFor(defaultEnvMode.envMode),
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
            ...(options?.environmentSelection
              ? { environmentSelection: options.environmentSelection }
              : {}),
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
          },
        );
        const opened = {
          draftId: emptyStoredDraftThread.draftId,
          threadId: emptyStoredDraftThread.threadId,
        };
        seedPrompt(emptyStoredDraftThread.draftId);
        applyProjectFile?.(emptyStoredDraftThread.draftId);
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
      seedPrompt(currentRouteTarget.draftId);
      return Promise.resolve({
        draftId: currentRouteTarget.draftId,
        threadId: latestActiveDraftThread.threadId,
      });
    }

    const draftId = requestedFreshDraft?.draftId ?? newDraftId();
    const threadId = requestedFreshDraft?.threadId ?? newThreadId();
    const createdAt = new Date().toISOString();
    return (async () => {
      const defaultEnvMode = options?.envMode === undefined ? resolveDefaultEnvMode() : null;
      const initialEnvMode = options?.envMode ?? defaultEnvMode?.envMode ?? "local";
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        preservePreviousDraft: requestedFreshDraft !== undefined,
        ...(options?.environmentSelection
          ? { environmentSelection: options.environmentSelection }
          : {}),
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: initialEnvMode,
        startFromOrigin: options?.startFromOrigin ?? startFromOriginFor(initialEnvMode),
        runtimeMode: defaultRuntimeMode,
        ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
      });
      applyDefaultModel(draftId);
      carryComposerContentTo(draftId);
      seedPrompt(draftId);
      defaultEnvMode?.applyProjectFile(draftId);
      if (options?.navigate !== false) {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
      }
      carryComposerContentTo(draftId);
      seedPrompt(draftId);
      return { draftId, threadId };
    })();
  };
}

export function resolveDefaultProjectRef(
  projects: ReadonlyArray<EnvironmentProject>,
  projectOrder: readonly string[],
  lastUsedProjectKey: string | null,
  fallbackReady = true,
  groupingSettings?: ProjectGroupingSettings,
): ScopedProjectRef | null {
  const lastUsed = projects.find(
    (project) =>
      project.archivedAt == null &&
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) === lastUsedProjectKey,
  );
  if (lastUsed) return scopeProjectRef(lastUsed.environmentId, lastUsed.id);
  if (!fallbackReady) return null;
  const liveProjects = projects.filter((project) => project.archivedAt == null);
  const [firstProject] = orderItemsByPreferredIds({
    items: liveProjects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  if (!firstProject) return null;
  const defaultProject = groupingSettings
    ? resolveGroupDefaultProject(firstProject, liveProjects, groupingSettings)
    : firstProject;
  return scopeProjectRef(defaultProject.environmentId, defaultProject.id);
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const [lastUsedProjectKey] = useLocalStorage(
    LAST_USED_PROJECT_STORAGE_KEY,
    null,
    lastUsedProjectKeySchema,
  );
  const defaultProjectFallbackReady = useAtomValue(
    defaultProjectFallbackReadyAtom(lastUsedProjectKey),
  );
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
  const handleNewThread = useNewThreadHandler();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const defaultProjectRef = resolveDefaultProjectRef(
    [
      ...orderedProjects.filter((project) => project.environmentId === primaryEnvironmentId),
      ...orderedProjects.filter((project) => project.environmentId !== primaryEnvironmentId),
    ],
    [],
    lastUsedProjectKey,
    defaultProjectFallbackReady,
    groupingSettings,
  );

  return {
    activeDraftThread,
    activeThread,
    preferredProjectRef,
    defaultProjectRef,
    defaultProjectFallbackReady,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
