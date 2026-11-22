import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadFamilies,
  useEnvironmentThread,
} from "../state/threads";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useEnvironmentProviders,
} from "../state/environments";
import { shouldTypeToFocusComposer } from "../components/chat/composerFocusRedirect";
// @effect-diagnostics cryptoRandomUUID:off -- Synchronous workspace drag-and-drop allocates local view identities.
import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { canSettle, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { createFileRoute } from "@tanstack/react-router";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  Columns3Icon,
  FolderOpenIcon,
  Grid2X2Icon,
  GripVerticalIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCcwIcon,
  Rows3Icon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffectEvent,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { EmptyWorkspacePane } from "../components/EmptyWorkspacePane";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { ChatViewContent } from "../components/ChatView";
import { ChatHeader } from "../components/chat/ChatHeader";
import { openThreadFind } from "../components/chat/threadFindStore";
import {
  WorkspacePaneHeaderContext,
  WorkspacePaneNavigationContext,
} from "../workspacePaneNavigation";
import { WorkspaceUpdatePill } from "../components/sidebar/SidebarUpdatePill";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/menu";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  useEnvironmentBootstrapComplete,
  useAnyEnvironmentHiding,
  useQuietThreadShell,
  useThreadDetailExists,
  useProjects,
  useServerConfigs,
  useThreadRefs,
  useThreadShellExists,
  useThreadShells,
  useThreadStatus,
  useThreadTitle,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { useClientSettings } from "../hooks/useSettings";
import { useDesktopFullscreen } from "../hooks/useDesktopFullscreen";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { m } from "../i18n/messages";
import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
  WORKSPACE_PANE_COUNT,
  WORKSPACE_PANE_COUNTS,
  type WorkspacePaneCount,
  type WorkspacePaneIndex,
  type WorkspacePaneTarget,
} from "../workspacePaneStore";
import {
  resolveWorkspaceGridColumnCount,
  resolveWorkspaceGridLeadRowSpan,
} from "../workspacePaneLayout";
import { resolveWorkspaceDraftThreadRef } from "../workspacePaneTitle";
import {
  buildWorkspaceThreadPickerItems,
  createWorkspaceRunningSubagentsAtomFamily,
  type WorkspaceRunningSubagent,
  type WorkspaceThreadPickerItem,
} from "../workspacePaneThreadPicker";
import { cn } from "~/lib/utils";
import { newDraftId, newThreadId } from "../lib/utils";

const WORKSPACE_PANE_DRAG_TYPE = "application/x-t3code-workspace-pane";
const WORKSPACE_LAYOUT_OPTIONS = [
  ["grid", Grid2X2Icon, msg("Grid layout")],
  ["columns", Columns3Icon, msg("Column layout")],
  ["rows", Rows3Icon, msg("Row layout")],
] as const;

function hasWorkspacePaneDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORKSPACE_PANE_DRAG_TYPE);
}

// Panes are keyed by what they show, not by slot, so swapping two panes keeps
// their chat views, terminals, and previews mounted.
function workspacePaneRenderKey(target: WorkspacePaneTarget | null, index: number): string {
  if (target === null) return `empty:${index}`;
  return "draftId" in target ? `draft:${target.draftId}` : `thread:${scopedThreadKey(target)}`;
}

function findInPaneThread(threadRef: ScopedThreadRef) {
  openThreadFind(scopedThreadKey(threadRef));
}

function WorkspacePaneThreadTitle({
  threadRef,
  showActions = true,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly showActions?: boolean;
}) {
  const gt = useGT();
  const title = useThreadTitle(threadRef);
  const threadHidden = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom, (keys) =>
    keys.has(threadKey(threadRef)),
  );
  const canFind = useAtomValue(
    environmentPresentations.serverConfigsAtom,
    (configs) => configs.get(threadRef.environmentId)?.threadFind === true,
  );

  if (title === null || !showActions || threadHidden) {
    const displayTitle = title ?? gt("Loading thread…");
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 flex-1 truncate text-center text-foreground" />}
        >
          {displayTitle}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{displayTitle}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <ChatHeader
      paneTitleOnly
      activeThreadEnvironmentId={threadRef.environmentId}
      activeThreadId={threadRef.threadId}
      activeThreadTitle={title}
      isServerThread
      onFindInThread={canFind ? findInPaneThread : undefined}
    />
  );
}

function WorkspacePaneDraftTitle({ draftId }: { readonly draftId: DraftId }) {
  const draftSession = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const serverThreadRef = resolveWorkspaceDraftThreadRef(draftSession, threadRefs);

  return serverThreadRef ? (
    <WorkspacePaneThreadTitle threadRef={serverThreadRef} showActions={false} />
  ) : (
    <span className="min-w-0 flex-1 truncate text-center text-muted-foreground">
      <T>New thread</T>
    </span>
  );
}

function WorkspaceThreadPane({
  threadRef,
  focused,
  composerHandleRef,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly focused: boolean;
  readonly composerHandleRef: RefObject<ChatComposerHandle | null>;
}) {
  const bootstrapComplete = useEnvironmentBootstrapComplete(threadRef.environmentId);
  const serverThreadShellExists = useThreadShellExists(threadRef);
  const serverThreadDetailExists = useThreadDetailExists(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAnyEnvironmentHiding();
  const unlistedThreadDetail = useEnvironmentThread(
    serverThreadShellExists ? null : threadRef.environmentId,
    serverThreadShellExists ? null : threadRef.threadId,
  );
  const unlistedThread = Option.getOrNull(unlistedThreadDetail.data)?.thread;
  const lineage = unlistedThread?.lineage;
  const unlistedParentRef =
    lineage && !isListedThreadLineage(lineage) && lineage.parentThreadId !== null
      ? scopeThreadRef(
          lineage.parentEnvironmentId ?? threadRef.environmentId,
          lineage.parentThreadId,
        )
      : (unlistedThread?.delegatedFrom ?? null);
  const unlistedParentKey = unlistedParentRef === null ? null : threadKey(unlistedParentRef);
  const unlistedParent = useQuietThreadShell(unlistedParentRef);
  const threadHidden = hiddenKeys.has(threadKey(threadRef));
  const offShellBlocked =
    hidingAnywhere &&
    !serverThreadShellExists &&
    (unlistedParentKey === null || unlistedParent === null || hiddenKeys.has(unlistedParentKey));
  const [retainFamily, setRetainFamily] = useState(false);
  if (bootstrapComplete && !serverThreadShellExists && !offShellBlocked && !retainFamily) {
    setRetainFamily(true);
  }
  const { environmentId, threadId } = threadRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the opened off-shell thread while the pane is mounted
  useEffect(() => {
    if (retainFamily && !threadHidden) {
      return threadFamilies.mount(appAtomRegistry, environmentId, threadId);
    }
  }, [environmentId, threadId, retainFamily, threadHidden]);

  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShellExists || serverThreadDetailExists,
    serverThreadDeleted: serverThreadStatus === "deleted",
    unlistedThreadDetail,
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetailExists,
    shellExists: serverThreadShellExists,
    status: serverThreadStatus,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops queued file inserts after the environment confirms the thread is missing
  useEffect(() => {
    if (renderState === "missing") {
      useSidebarPendingFileDropStore
        .getState()
        .clearPendingFileDropsForThread({ environmentId, threadId });
    }
  }, [environmentId, threadId, renderState]);

  if (
    threadHidden ||
    (offShellBlocked && unlistedThread !== undefined) ||
    renderState === "missing"
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        <T>This thread is no longer available. Clear the pane and choose another thread.</T>
      </div>
    );
  }

  if (offShellBlocked || (renderState === "loading" && !serverThreadShellExists)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
        <T>Loading thread…</T>
      </div>
    );
  }

  return (
    <ChatViewContent
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
      reserveTitleBarControlInset={false}
      embeddedPane
      isPaneFocused={focused}
      composerHandleRef={composerHandleRef}
    />
  );
}

function WorkspaceDraftPane({
  workspaceKey,
  index,
  draftId,
  focused,
  composerHandleRef,
}: {
  readonly workspaceKey: string;
  readonly index: WorkspacePaneIndex;
  readonly draftId: DraftId;
  readonly focused: boolean;
  readonly composerHandleRef: RefObject<ChatComposerHandle | null>;
}) {
  const draftSession = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const draftRedirect = useComposerDraftStore((state) => state.getPromotedDraftRedirect(draftId));
  const retainDraftThread = useComposerDraftStore((state) => state.retainDraftThread);
  const releaseDraftThread = useComposerDraftStore((state) => state.releaseDraftThread);
  const assignThread = useWorkspacePaneStore((state) => state.assignThread);
  const clearPane = useWorkspacePaneStore((state) => state.clearPane);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the pane draft while mounted and releases it on unmount
  useEffect(() => {
    retainDraftThread(draftId);
    return () => releaseDraftThread(draftId);
  }, [draftId, releaseDraftThread, retainDraftThread]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears a restored pane whose draft no longer exists after storage hydration
  useEffect(() => {
    if (draftSession || !useComposerDraftStore.persist.hasHydrated()) return;
    if (draftRedirect) assignThread(workspaceKey, draftRedirect, index);
    else clearPane(workspaceKey, index);
  }, [assignThread, clearPane, draftRedirect, draftSession, index, workspaceKey]);

  if (!draftSession) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
        <T>Restoring composer…</T>
      </div>
    );
  }

  return (
    <ChatViewContent
      draftId={draftId}
      environmentId={draftSession.environmentId}
      threadId={draftSession.threadId}
      routeKind="draft"
      reserveTitleBarControlInset={false}
      embeddedPane
      isPaneFocused={focused}
      composerHandleRef={composerHandleRef}
    />
  );
}

const workspaceRunningSubagentsAtom = createWorkspaceRunningSubagentsAtomFamily({
  threads: environmentThreadShells.threadShellsAtom,
  remoteSubagents: (ref) =>
    Atom.map(
      environmentThreadDetails.threadAtom(ref),
      (thread) => thread?.projection.subagents ?? [],
    ).pipe(Atom.setIdleTTL(0)),
});

function RunningSubagentProviderIcon({ agent }: { readonly agent: WorkspaceRunningSubagent }) {
  const providers = useEnvironmentProviders();
  const instanceId = agent.providerInstanceId;
  const provider = providers
    .get(agent.environmentId)
    ?.find((candidate) => candidate.instanceId === instanceId);
  if (!provider) return <BotIcon className="size-3.5 shrink-0" aria-hidden />;
  return (
    <span
      className="inline-flex shrink-0"
      role="img"
      aria-label={provider.displayName ?? provider.driver}
    >
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={provider.displayName ?? provider.driver}
        acpRegistryIconUrl={provider.iconUrl}
        iconClassName="size-3.5"
      />
    </span>
  );
}

const WorkspacePaneRunningSubagents = memo(function WorkspacePaneRunningSubagents({
  threadRef,
  openRelated,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly openRelated: (ref: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const runningSubagents = useAtomValue(workspaceRunningSubagentsAtom(threadRef));
  return runningSubagents.length === 1 ? (
    <Button
      size="xs"
      variant="ghost"
      aria-label={gt("Open running agent: {agentTitle}", {
        agentTitle: runningSubagents[0]!.title,
      })}
      onClick={() => {
        const agent = runningSubagents[0]!;
        openRelated(scopeThreadRef(agent.environmentId, agent.id));
      }}
    >
      <RunningSubagentProviderIcon agent={runningSubagents[0]!} />
      <T>1 running</T>
    </Button>
  ) : runningSubagents.length > 1 ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="ghost" />}
        aria-label={gt(
          "{count, plural, one {{count} running agent} other {{count} running agents}}",
          { count: runningSubagents.length },
        )}
      >
        <T>
          <Var>{runningSubagents.length}</Var> running
        </T>
        <ChevronDownIcon className="size-3" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <T>Running agents</T>
          </DropdownMenuLabel>
          {runningSubagents.map((agent) => (
            <DropdownMenuItem
              key={scopedThreadKey(scopeThreadRef(agent.environmentId, agent.id))}
              onClick={() => openRelated(scopeThreadRef(agent.environmentId, agent.id))}
            >
              <RunningSubagentProviderIcon agent={agent} />
              <span className="truncate">{agent.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
});

const WorkspacePane = memo(function WorkspacePane({
  workspaceKey,
  index,
  paneTarget,
  projectKey,
  projects,
  focused,
  maximized,
  rearrangeable,
  leadPaneRowSpan,
  composerHandleRef,
  settleThread,
}: {
  readonly workspaceKey: string;
  readonly index: WorkspacePaneIndex;
  readonly paneTarget: WorkspacePaneTarget | null;
  readonly projectKey: string | null;
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly rearrangeable: boolean;
  readonly leadPaneRowSpan: number;
  readonly composerHandleRef: RefObject<ChatComposerHandle | null>;
  readonly settleThread: ReturnType<typeof useThreadActions>["settleThread"];
}) {
  const gt = useGT();
  const paneNumber = index + 1;
  const backLabel = gt("Back in pane");
  const settleLabel = gt("Settle thread and clear pane");
  const maximizeLabel = maximized ? gt("Restore pane") : gt("Maximize pane");
  const removeLabel = gt("Remove from pane. Thread keeps running");
  const openRelatedThread = useWorkspacePaneStore((state) => state.openRelatedThread);
  const goBack = useWorkspacePaneStore((state) => state.goBack);
  const canGoBack = useWorkspacePaneStore(
    (state) =>
      (selectProjectWorkspaceLayout(state, workspaceKey).backStacks?.[index]?.length ?? 0) > 0,
  );
  const openRelated = useStableCallback((threadRef: ScopedThreadRef) => {
    openRelatedThread(workspaceKey, threadRef, index);
  });
  const focusPane = useWorkspacePaneStore((state) => state.focusPane);
  const clearPane = useWorkspacePaneStore((state) => state.clearPane);
  const setPaneProject = useWorkspacePaneStore((state) => state.setPaneProject);
  const assignThread = useWorkspacePaneStore((state) => state.assignThread);
  const assignDraft = useWorkspacePaneStore((state) => state.assignDraft);
  const toggleMaximize = useWorkspacePaneStore((state) => state.toggleMaximize);
  const swapPanes = useWorkspacePaneStore((state) => state.swapPanes);
  const hiddenPickerProjectKeys = useWorkspacePaneStore((state) => state.hiddenPickerProjectKeys);
  const setPickerProjectHidden = useWorkspacePaneStore((state) => state.setPickerProjectHidden);
  const handleNewThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();
  const scratchEnvironments = useLogicalProjectEnvironments(
    projects.find((project) => project.isScratch) ?? null,
    true,
  );
  const [pendingProjectRef, setPendingProjectRef] = useState<ScopedProjectRef | null>(null);
  const [settling, setSettling] = useState(false);
  const [draggingPane, setDraggingPane] = useState(false);
  const [paneDropActive, setPaneDropActive] = useState(false);
  const [headerControls, setHeaderControls] = useState<HTMLDivElement | null>(null);
  const draftRequestVersionRef = useRef(0);
  const serverThreadRef = paneTarget && "threadId" in paneTarget ? paneTarget : null;
  const serverThreadShell = useQuietThreadShell(serverThreadRef);
  const openFreshDraft = useStableCallback((projectRef: ScopedProjectRef) => {
    const requestVersion = ++draftRequestVersionRef.current;
    const freshDraft = { draftId: newDraftId(), threadId: newThreadId() };
    void handleNewThread(projectRef, { navigate: false, freshDraft }).then((opened) => {
      if (draftRequestVersionRef.current === requestVersion && opened) {
        assignDraft(workspaceKey, opened.draftId, index);
      }
    });
  });
  const selectProject = useStableCallback((projectRef: ScopedProjectRef) => {
    draftRequestVersionRef.current += 1;
    const project = projects.find((candidate) =>
      candidate.memberProjectRefs.some(
        (member) =>
          member.environmentId === projectRef.environmentId &&
          member.projectId === projectRef.projectId,
      ),
    );
    if (!project) {
      setPendingProjectRef(projectRef);
      return;
    }
    setPendingProjectRef(null);
    // Choosing a hidden project, including re-adding its directory, puts it
    // back in the pane project menu.
    setPickerProjectHidden(project.projectKey, false);
    setPaneProject(workspaceKey, index, project.projectKey);
  });
  const openProjectPicker = useStableCallback(() =>
    openCommandPalette({ open: "add-local-project", onProjectSelected: selectProject }),
  );
  const selectedProject = (() =>
    projects.find((project) => project.projectKey === projectKey) ?? null)();
  const [menuProjects, hiddenMenuProjects] = (() => {
    const hiddenKeys = new Set(hiddenPickerProjectKeys);
    // Archived projects stay out of the pane menu, as they do in the sidebar.
    const pickable = pickableProjectGroups(projects);
    return [
      pickable.filter((project) => project.isScratch || !hiddenKeys.has(project.projectKey)),
      pickable.filter((project) => !project.isScratch && hiddenKeys.has(project.projectKey)),
    ];
  })();
  const resolvePendingProject = useEffectEvent(() => {
    if (pendingProjectRef) selectProject(pendingProjectRef);
  });
  const pendingProjectReady =
    pendingProjectRef !== null &&
    projects.some((project) =>
      project.memberProjectRefs.some(
        (member) =>
          member.environmentId === pendingProjectRef.environmentId &&
          member.projectId === pendingProjectRef.projectId,
      ),
    );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- completes the asynchronous project selection after its projection arrives
  useEffect(() => {
    if (pendingProjectReady) resolvePendingProject();
  }, [pendingProjectReady]);

  const startNewThread = useStableCallback(
    async (project: SidebarProjectSnapshot | null, environmentId?: EnvironmentId) => {
      const requestVersion = ++draftRequestVersionRef.current;
      const destination =
        (!project || project.isScratch) && environmentId
          ? await openScratchProject(environmentId)
          : project;
      if (!destination || draftRequestVersionRef.current !== requestVersion) return;
      const projectRef = scopeProjectRef(destination.environmentId, destination.id);
      selectProject(projectRef);
      openFreshDraft(projectRef);
    },
  );
  const openExistingThread = useStableCallback((thread: WorkspaceThreadPickerItem) => {
    draftRequestVersionRef.current += 1;
    if (thread.paneIndex === null) setPaneProject(workspaceKey, index, thread.projectKey);
    assignThread(workspaceKey, thread.threadRef, index);
  });
  const handleClearPane = useStableCallback(() => {
    // Invalidate a project selection that is still preparing its draft so it
    // cannot repopulate the pane after the user clears it.
    draftRequestVersionRef.current += 1;
    clearPane(workspaceKey, index);
  });
  const settlementNow = useNowMinute();
  const settleAvailable =
    serverThreadShell !== null && canSettle(serverThreadShell, { now: settlementNow });
  const finishThread = useStableCallback(async () => {
    if (!serverThreadRef || settling) return;
    setSettling(true);
    const result = await settleThread(serverThreadRef);
    setSettling(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not finish thread")),
          description:
            error instanceof Error ? error.message : m(msg("The thread was not settled.")),
        }),
      );
      return;
    }
    clearPane(workspaceKey, index);
  });

  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background",
        focused ? "z-10 border-primary ring-1 ring-primary/50" : "border-border",
      )}
      style={{
        order: index,
        gridRow: index === 0 && leadPaneRowSpan > 1 ? `span ${leadPaneRowSpan}` : undefined,
      }}
      aria-label={gt("Workspace pane {paneNumber}", { paneNumber })}
      data-workspace-pane={index}
      data-focused={focused ? "true" : "false"}
      onDragOverCapture={(event) => {
        if (draggingPane || !hasWorkspacePaneDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setPaneDropActive(true);
      }}
      onDragLeaveCapture={(event) => {
        if (!hasWorkspacePaneDrag(event.dataTransfer)) return;
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setPaneDropActive(false);
      }}
      onDropCapture={(event) => {
        if (hasWorkspacePaneDrag(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          setPaneDropActive(false);
          const source = event.dataTransfer.getData(WORKSPACE_PANE_DRAG_TYPE);
          const separator = source.lastIndexOf(":");
          const sourceIndex = Number(source.slice(separator + 1));
          if (source.slice(0, separator) !== workspaceKey || !Number.isInteger(sourceIndex)) return;
          swapPanes(workspaceKey, sourceIndex as WorkspacePaneIndex, index);
          return;
        }
        if (
          !event.dataTransfer.types.includes("Files") ||
          event.dataTransfer.files.length === 0 ||
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target)
        )
          return;
        const composer = composerHandleRef.current;
        if (!composer) return;
        // External drops do not press the pane. Select it before attachment
        // processing so typing cannot be redirected to the previous composer.
        focusPane(workspaceKey, index);
        composer.focusAtEnd();
      }}
      onPointerDownCapture={(event) => {
        // Portaled browser chrome belongs to its thread, but dragging it must
        // not select that thread's pane or redirect composer keyboard input.
        if (event.target instanceof Element && event.target.closest("[data-preview-mini-player]"))
          return;
        focusPane(workspaceKey, index);
      }}
    >
      {paneDropActive ? (
        <div
          className="pointer-events-none absolute inset-0 z-50 border-2 border-primary bg-primary/10"
          aria-hidden
        />
      ) : null}
      <div
        data-workspace-pane-header
        className={cn(
          "flex h-7 shrink-0 items-center border-b px-2 text-2xs font-medium",
          focused
            ? "border-primary/40 bg-primary/[0.07] text-foreground"
            : "border-border bg-muted/30 text-muted-foreground",
          rearrangeable && "cursor-grab active:cursor-grabbing",
          draggingPane && "opacity-60",
        )}
        draggable={rearrangeable}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(WORKSPACE_PANE_DRAG_TYPE, `${workspaceKey}:${index}`);
          setDraggingPane(true);
        }}
        onDragEnd={() => setDraggingPane(false)}
        onDoubleClick={() => toggleMaximize(workspaceKey, index)}
      >
        {rearrangeable ? (
          <Tooltip>
            <TooltipTrigger render={<span className="-ml-1 flex shrink-0 items-center" />}>
              <GripVerticalIcon className="size-3 text-muted-foreground/60" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Drag onto another pane to swap</T>
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {paneTarget === null ? (
          <span className="px-1 text-muted-foreground">
            <T>
              Pane <Var>{paneNumber}</Var>
            </T>
          </span>
        ) : projects.length === 0 ? (
          <button
            type="button"
            className="flex h-5 min-w-0 max-w-[45%] items-center gap-1.5 truncate rounded px-1.5 text-left text-2xs text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={openProjectPicker}
          >
            <FolderOpenIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">
              <T>Choose project</T>
            </span>
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-5 min-w-0 max-w-[45%] items-center gap-1 rounded px-1.5 text-left text-2xs text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
              aria-label={gt("Change project for pane {paneNumber}", { paneNumber })}
            >
              {selectedProject ? (
                <ProjectFavicon project={selectedProject} className="size-3 shrink-0" />
              ) : null}
              <span className="truncate">
                {selectedProject?.displayName ?? <T>Choose project</T>}
              </span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  <T>Project for this pane</T>
                </DropdownMenuLabel>
                {!menuProjects.some((project) => project.isScratch) ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <T>No project</T>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          <T>New thread on</T>
                        </DropdownMenuLabel>
                        {scratchEnvironments.map((environment) => (
                          <DropdownMenuItem
                            key={environment.environmentId}
                            disabled={environment.disabledReason !== undefined}
                            onClick={() => void startNewThread(null, environment.environmentId)}
                          >
                            <EnvironmentMachineIcon
                              kind={environment.machine}
                              className="size-4 shrink-0"
                            />
                            {environment.label}
                            {environment.disabledReason ? (
                              <span className="text-muted-foreground">
                                {environment.disabledReason}
                              </span>
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {menuProjects.map((project) =>
                  project.isScratch ? (
                    <DropdownMenuSub key={project.projectKey}>
                      <DropdownMenuSubTrigger>
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                        {project.displayName}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onClick={() =>
                              selectProject(scopeProjectRef(project.environmentId, project.id))
                            }
                          >
                            <T>Browse threads</T>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>
                            <T>New thread on</T>
                          </DropdownMenuLabel>
                          {scratchEnvironments.map((environment) => (
                            <DropdownMenuItem
                              key={environment.environmentId}
                              disabled={environment.disabledReason !== undefined}
                              onClick={() =>
                                void startNewThread(project, environment.environmentId)
                              }
                            >
                              <EnvironmentMachineIcon
                                kind={environment.machine}
                                className="size-4 shrink-0"
                              />
                              {environment.label}
                              {environment.disabledReason ? (
                                <span className="text-muted-foreground">
                                  {environment.disabledReason}
                                </span>
                              ) : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : (
                    <DropdownMenuItem
                      key={project.projectKey}
                      className="group"
                      render={
                        <div
                          className={
                            project.projectKey === projectKey ? "bg-foreground/[0.08]" : undefined
                          }
                        />
                      }
                      onClick={() =>
                        selectProject(scopeProjectRef(project.environmentId, project.id))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Delete" && event.key !== "Backspace") return;
                        event.preventDefault();
                        setPickerProjectHidden(project.projectKey, true);
                      }}
                    >
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{project.displayName}</span>
                        <span className="block truncate text-2xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      </span>
                      <button
                        type="button"
                        tabIndex={-1}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-data-highlighted:opacity-100 pointer-coarse:opacity-100"
                        aria-label={gt("Hide {projectName} from this list", {
                          projectName: project.displayName,
                        })}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setPickerProjectHidden(project.projectKey, true);
                        }}
                      >
                        <XIcon className="size-3" aria-hidden />
                      </button>
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {hiddenMenuProjects.length > 0 ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <T>
                      Hidden projects (<Var>{hiddenMenuProjects.length}</Var>)
                    </T>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-72">
                    {hiddenMenuProjects.map((project) => (
                      <DropdownMenuItem
                        key={project.projectKey}
                        onClick={() =>
                          selectProject(scopeProjectRef(project.environmentId, project.id))
                        }
                      >
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{project.displayName}</span>
                          <span className="block truncate text-2xs text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              {projectKey !== null ? (
                <DropdownMenuItem onClick={() => setPaneProject(workspaceKey, index, null)}>
                  <T>Clear project</T>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={openProjectPicker}>
                <FolderOpenIcon />
                <T>Add project or directory…</T>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {paneTarget ? (
          <span className="mx-1 shrink-0 text-border" aria-hidden>
            /
          </span>
        ) : null}
        {paneTarget && "threadId" in paneTarget ? (
          <WorkspacePaneThreadTitle threadRef={paneTarget} />
        ) : paneTarget ? (
          <WorkspacePaneDraftTitle draftId={paneTarget.draftId} />
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <div ref={setHeaderControls} className="flex shrink-0 items-center" />
          {serverThreadRef ? (
            <WorkspacePaneRunningSubagents threadRef={serverThreadRef} openRelated={openRelated} />
          ) : null}
          {canGoBack ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={backLabel}
              title={backLabel}
              onClick={() => goBack(workspaceKey, index)}
            >
              <ArrowLeftIcon className="size-3" />
            </Button>
          ) : null}
          {serverThreadRef ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={settleLabel}
              title={settleAvailable ? settleLabel : gt("Thread still needs attention")}
              disabled={settling || !settleAvailable}
              onClick={() => void finishThread()}
            >
              <CircleCheckIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={maximizeLabel}
            title={maximizeLabel}
            onClick={() => toggleMaximize(workspaceKey, index)}
          >
            {maximized ? (
              <Minimize2Icon className="size-3" />
            ) : (
              <Maximize2Icon className="size-3" />
            )}
          </Button>
          {paneTarget ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={handleClearPane}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      <WorkspacePaneNavigationContext value={openRelated}>
        <WorkspacePaneHeaderContext value={headerControls}>
          {paneTarget && "draftId" in paneTarget ? (
            <WorkspaceDraftPane
              workspaceKey={workspaceKey}
              index={index}
              draftId={paneTarget.draftId}
              focused={focused}
              composerHandleRef={composerHandleRef}
            />
          ) : paneTarget ? (
            <WorkspaceThreadPane
              threadRef={paneTarget}
              focused={focused}
              composerHandleRef={composerHandleRef}
            />
          ) : (
            <WorkspacePaneThreadBrowser
              workspaceKey={workspaceKey}
              projectGroups={projects}
              projects={menuProjects}
              hiddenProjects={hiddenMenuProjects}
              onShowAll={() => setPaneProject(workspaceKey, index, null)}
              onHideProject={(project) => {
                setPickerProjectHidden(project.projectKey, true);
                if (project.projectKey === projectKey) setPaneProject(workspaceKey, index, null);
              }}
              selectedProjectKey={selectedProject?.projectKey ?? null}
              onSelectProject={(project) =>
                selectProject(scopeProjectRef(project.environmentId, project.id))
              }
              onAddProject={openProjectPicker}
              scratchEnvironments={scratchEnvironments}
              onNewThread={startNewThread}
              onSelectThread={openExistingThread}
            />
          )}
        </WorkspacePaneHeaderContext>
      </WorkspacePaneNavigationContext>
    </section>
  );
});

const workspaceScheduledTasksAtom = environmentAtomList(
  "web-workspace-scheduled-tasks",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

function WorkspacePaneThreadBrowser({
  workspaceKey,
  projectGroups,
  ...props
}: Omit<ComponentProps<typeof EmptyWorkspacePane>, "threads"> & {
  readonly workspaceKey: string;
  readonly projectGroups: readonly SidebarProjectSnapshot[];
}) {
  const threads = useThreadShells();
  const environments = useEnvironmentIdentities();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const serverConfigs = useServerConfigs();
  const scheduledEnvironmentIds = connectedEnvironmentIds.filter((environmentId) =>
    serverConfigs.has(environmentId),
  );
  const scheduledTaskQueries = useAtomValue(
    workspaceScheduledTasksAtom(environmentIdsKey(scheduledEnvironmentIds)),
  );
  const nowMinute = useNowMinute();
  const { panes, paneCount } = useWorkspacePaneStore((state) =>
    selectProjectWorkspaceLayout(state, workspaceKey),
  );
  const now = `${nowMinute}:00.000Z`;
  const settledThreadKeys = new Set(
    threads.flatMap((thread) => {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadSettlement !== true) return [];
      if (capabilities.threadSnooze === true && effectiveSnoozed(thread, { now })) return [];
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      return thread.settledOverride === "settled" ? [threadKey] : [];
    }),
  );
  const scheduledThreadKeys = new Set<string>();
  scheduledEnvironmentIds.forEach((environmentId, index) => {
    const query = scheduledTaskQueries[index];
    const data = query ? AsyncResult.getOrElse(query, () => null) : null;
    for (const task of data?.tasks ?? []) {
      if (task.threadId !== null) {
        scheduledThreadKeys.add(scopedThreadKey(scopeThreadRef(environmentId, task.threadId)));
      }
    }
  });
  const availableThreads = buildWorkspaceThreadPickerItems({
    threads,
    projects: projectGroups,
    paneTargets: panes.slice(0, paneCount),
    environmentLabels: new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    ),
    settledThreadKeys,
    scheduledThreadKeys,
  });
  return <EmptyWorkspacePane {...props} threads={availableThreads} />;
}

export function ProjectPaneWorkspace({
  workspaceKey,
  active = true,
}: {
  readonly workspaceKey: string;
  readonly active?: boolean;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const resetLabel = gt("Reset workspace");
  const newWindowLabel = gt("Open workspace in new window");
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { isMacosDesktop, isWindowFullscreen } = useDesktopFullscreen();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectGroups = buildSidebarProjectSnapshots({
    projects,
    settings: projectGroupingSettings,
    groupScratchProjects: true,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
  const layout = useWorkspacePaneStore((state) =>
    selectProjectWorkspaceLayout(state, workspaceKey),
  );
  const setPaneCount = useWorkspacePaneStore((state) => state.setPaneCount);
  const setLayoutMode = useWorkspacePaneStore((state) => state.setLayoutMode);
  const resetWorkspace = useWorkspacePaneStore((state) => state.resetWorkspace);
  const { settleThread } = useThreadActions();
  const settlePaneThread = useStableCallback(settleThread);
  const { panes, projectKeys, paneCount, layoutMode, focusedPaneIndex, maximizedPaneIndex } =
    layout;
  const leadPaneRowSpan =
    layoutMode === "grid" && maximizedPaneIndex === null
      ? resolveWorkspaceGridLeadRowSpan(paneCount)
      : 1;
  // DOM order stays sorted by render key; CSS order places each pane in its
  // slot, so a swap restyles panes instead of moving live DOM nodes.
  const renderedPanes = panes
    .slice(0, paneCount)
    .map((paneTarget, index) => ({
      paneTarget,
      index: index as WorkspacePaneIndex,
      key: `${workspacePaneRenderKey(paneTarget, index)}:${panes.slice(0, index).filter((target) => target && paneTarget && "threadId" in target && "threadId" in paneTarget && scopedThreadKey(target) === scopedThreadKey(paneTarget)).length}`,
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
  const [paneComposerHandleRefs] = useState(() =>
    Array.from(
      { length: WORKSPACE_PANE_COUNT },
      () => ({ current: null }) as RefObject<ChatComposerHandle | null>,
    ),
  );
  const openWorkspaceWindow = useStableCallback(() => {
    const nextWorkspace = window.crypto.randomUUID();
    // Electron routes with hash history, so the workspace id must live in the
    // fragment or the new window falls back to the shared "main" workspace.
    const path = `/workspace?workspace=${encodeURIComponent(nextWorkspace)}`;
    window.open(isElectron ? `/#${path}` : path, "_blank");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes workspace keyboard commands only while its panes are active
  useEffect(() => {
    if (!active) return;

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const currentFocusedPaneIndex = selectProjectWorkspaceLayout(
        useWorkspacePaneStore.getState(),
        workspaceKey,
      ).focusedPaneIndex;
      const focusedComposer = paneComposerHandleRefs[currentFocusedPaneIndex]?.current;
      if (
        !isTerminalFocused() &&
        !isModelPickerOpen() &&
        shouldTypeToFocusComposer(event, { redirectFromUnfocusedWorkspacePane: true }) &&
        focusedComposer?.startTypingAtEnd(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const paneCountMatch = /^workspace\.paneCount\.([1-9])$/.exec(command ?? "");
      const nextPaneCount = paneCountMatch?.[1]
        ? (Number(paneCountMatch[1]) as WorkspacePaneCount)
        : null;
      if (nextPaneCount !== null) {
        event.preventDefault();
        event.stopPropagation();
        setPaneCount(workspaceKey, nextPaneCount);
        return;
      }
      const nextLayoutMode =
        command === "workspace.layout.grid"
          ? "grid"
          : command === "workspace.layout.columns"
            ? "columns"
            : command === "workspace.layout.rows"
              ? "rows"
              : null;
      if (nextLayoutMode !== null) {
        event.preventDefault();
        event.stopPropagation();
        setLayoutMode(workspaceKey, nextLayoutMode);
        return;
      }
      if (command === "workspace.reset") {
        event.preventDefault();
        event.stopPropagation();
        resetWorkspace(workspaceKey);
        return;
      }
      if (command === "workspace.newWindow") {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceWindow();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
  }, [
    active,
    keybindings,
    openWorkspaceWindow,
    paneComposerHandleRefs,
    resetWorkspace,
    setLayoutMode,
    setPaneCount,
    workspaceKey,
  ]);

  return (
    <SidebarInset className="flex h-svh min-h-0 flex-col overflow-hidden overscroll-y-none  md:h-dvh">
      {active ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-50 flex justify-center",
            isMacosDesktop && !isWindowFullscreen
              ? "top-[calc(var(--workspace-topbar-height)+0.75rem)]"
              : "top-3",
          )}
        >
          <WorkspaceUpdatePill />
        </div>
      ) : null}
      {!isWindowFullscreen ? (
        <header className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-(--workspace-titlebar-content-left)">
          <div className="min-w-0 flex-1" aria-hidden />
          <div
            className="flex items-center gap-1 [-webkit-app-region:no-drag]"
            aria-label={gt("Workspace layout controls")}
          >
            <div className="relative h-6 w-[4.75rem] shrink-0 text-2xs">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground">
                <T>Panes</T>
              </span>
              <select
                aria-label={gt("Number of panes")}
                className="h-6 w-full appearance-none rounded-md border border-border bg-background pr-5 pl-10.5 text-2xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                value={String(paneCount)}
                onChange={(event) =>
                  setPaneCount(
                    workspaceKey,
                    Number(event.currentTarget.value) as WorkspacePaneCount,
                  )
                }
              >
                {WORKSPACE_PANE_COUNTS.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>
            {WORKSPACE_LAYOUT_OPTIONS.map(([mode, Icon, message]) => {
              const label = resolveMessage(message);
              return (
                <Button
                  key={mode}
                  size="icon-micro"
                  variant={layoutMode === mode ? "secondary" : "ghost"}
                  aria-label={label}
                  title={label}
                  onClick={() => setLayoutMode(workspaceKey, mode)}
                >
                  <Icon className="size-3" />
                </Button>
              );
            })}
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={resetLabel}
              title={resetLabel}
              onClick={() => resetWorkspace(workspaceKey)}
            >
              <RotateCcwIcon className="size-3" />
            </Button>
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={newWindowLabel}
              title={newWindowLabel}
              onClick={openWorkspaceWindow}
            >
              <SquareArrowOutUpRightIcon className="size-3" />
            </Button>
          </div>
        </header>
      ) : null}
      <main
        className={cn(
          "grid min-h-0 min-w-0 flex-1 bg-border",
          maximizedPaneIndex !== null ? "grid-cols-1 grid-rows-1" : "gap-px",
        )}
        style={
          maximizedPaneIndex !== null
            ? undefined
            : layoutMode === "columns"
              ? { gridTemplateColumns: `repeat(${paneCount}, minmax(0, 1fr))` }
              : layoutMode === "rows"
                ? { gridTemplateRows: `repeat(${paneCount}, minmax(0, 1fr))` }
                : {
                    gridTemplateColumns: `repeat(${resolveWorkspaceGridColumnCount(paneCount)}, minmax(0, 1fr))`,
                    gridAutoRows: "minmax(0, 1fr)",
                  }
        }
      >
        {renderedPanes.map(({ paneTarget, index, key }) => {
          if (maximizedPaneIndex !== null && maximizedPaneIndex !== index) return null;
          return (
            <WorkspacePane
              key={key}
              workspaceKey={workspaceKey}
              index={index}
              paneTarget={paneTarget}
              projectKey={resolveSidebarProjectScopeKey({
                groups: projectGroups,
                key: projectKeys[index] ?? null,
                settings: projectGroupingSettings,
              })}
              projects={projectGroups}
              focused={active && focusedPaneIndex === index}
              maximized={maximizedPaneIndex === index}
              rearrangeable={maximizedPaneIndex === null && paneCount > 1}
              leadPaneRowSpan={index === 0 ? leadPaneRowSpan : 1}
              composerHandleRef={paneComposerHandleRefs[index]!}
              settleThread={settlePaneThread}
            />
          );
        })}
      </main>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/workspace")({
  validateSearch: (search: Record<string, unknown>) => ({
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  component: () => null,
});
