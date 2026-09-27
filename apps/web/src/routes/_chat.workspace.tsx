import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { canSettle, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { createFileRoute } from "@tanstack/react-router";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  Columns3Icon,
  FolderOpenIcon,
  Grid2X2Icon,
  GripVerticalIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  MonitorUpIcon,
  RotateCcwIcon,
  Rows3Icon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { ChatViewContent, shouldTypeToFocusComposer } from "../components/ChatView";
import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  useThreadDetail,
  useProjects,
  useServerConfigs,
  useThreadRefs,
  useThreadShell,
  useThreadShells,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentShell } from "../state/shell";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useClientSettings } from "../hooks/useSettings";
import { useDesktopFullscreen } from "../hooks/useDesktopFullscreen";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  buildSidebarProjectSnapshots,
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
import {
  resolveWorkspaceDraftThreadRef,
  resolveWorkspacePaneThreadTitle,
} from "../workspacePaneTitle";
import {
  buildWorkspaceThreadPickerItems,
  workspaceThreadPickerItemsForProject,
  type WorkspaceThreadPickerItem,
} from "../workspacePaneThreadPicker";
import { cn } from "~/lib/utils";
import { newDraftId, newThreadId } from "../lib/utils";

const WORKSPACE_PANE_DRAG_TYPE = "application/x-t3code-workspace-pane";

function hasWorkspacePaneDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORKSPACE_PANE_DRAG_TYPE);
}

// Panes are keyed by what they show, not by slot, so swapping two panes keeps
// their chat views, terminals, and previews mounted.
function workspacePaneRenderKey(target: WorkspacePaneTarget | null, index: number): string {
  if (target === null) return `empty:${index}`;
  return "draftId" in target ? `draft:${target.draftId}` : `thread:${scopedThreadKey(target)}`;
}

function EmptyWorkspacePane({
  paneNumber,
  projectSelected,
  threads,
  onNewThread,
  onSelectThread,
}: {
  readonly paneNumber: number;
  readonly projectSelected: boolean;
  readonly threads: readonly WorkspaceThreadPickerItem[];
  readonly onNewThread: (() => void) | null;
  readonly onSelectThread: (thread: WorkspaceThreadPickerItem) => void;
}) {
  const openThreads = threads.filter((thread) => thread.status === "open");
  const settledThreads = threads.filter((thread) => thread.status === "settled");
  const renderThreads = (items: readonly WorkspaceThreadPickerItem[]) =>
    items.map((thread) => (
      <button
        key={`${thread.threadRef.environmentId}:${thread.threadRef.threadId}`}
        type="button"
        className="flex min-h-9 w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSelectThread(thread)}
      >
        {thread.status === "settled" ? (
          <CircleCheckIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        ) : (
          <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{thread.title}</span>
          {!projectSelected ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {thread.projectName}
            </span>
          ) : null}
        </span>
      </button>
    ));

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden bg-background px-6 py-4 text-center">
      <MonitorUpIcon className="size-6 text-muted-foreground/60" aria-hidden />
      <p className="text-sm font-medium text-foreground">Pane {paneNumber}</p>
      <p className="max-w-64 text-xs leading-5 text-muted-foreground">
        {projectSelected
          ? "Start a new thread or resume one from this project."
          : "Choose a project, or resume any open thread."}
      </p>
      {onNewThread ? (
        <Button size="sm" variant="outline" onClick={onNewThread}>
          New thread
        </Button>
      ) : null}
      {threads.length > 0 ? (
        <div className="mt-1 flex max-h-56 w-full max-w-sm flex-col overflow-y-auto rounded-md border border-border bg-muted/20 p-1 text-left">
          {openThreads.length > 0 ? (
            <>
              <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Open
              </p>
              {renderThreads(openThreads)}
            </>
          ) : null}
          {settledThreads.length > 0 ? (
            <>
              <p className="mt-1 border-t border-border px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Settled
              </p>
              {renderThreads(settledThreads)}
            </>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {projectSelected ? "No other open threads in this project." : "No open threads."}
        </p>
      )}
    </div>
  );
}

function WorkspacePaneThreadTitle({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const title = resolveWorkspacePaneThreadTitle(detail, shell);
  const displayTitle = title ?? "Loading thread…";

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

function WorkspacePaneDraftTitle({ draftId }: { readonly draftId: DraftId }) {
  const draftSession = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const serverThreadRef = resolveWorkspaceDraftThreadRef(draftSession, threadRefs);

  return serverThreadRef ? (
    <WorkspacePaneThreadTitle threadRef={serverThreadRef} />
  ) : (
    <span className="min-w-0 flex-1 truncate text-center text-muted-foreground">New thread</span>
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
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });

  if (renderState === "missing") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        This thread is no longer available. Clear the pane and choose another thread.
      </div>
    );
  }

  if (renderState === "loading" && serverThreadShell === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
        Loading thread…
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
  const threadRefs = useThreadRefs();
  const inferredThreadRef = resolveWorkspaceDraftThreadRef(draftSession, threadRefs);
  const retainDraftThread = useComposerDraftStore((state) => state.retainDraftThread);
  const releaseDraftThread = useComposerDraftStore((state) => state.releaseDraftThread);
  const assignThread = useWorkspacePaneStore((state) => state.assignThread);
  const clearPane = useWorkspacePaneStore((state) => state.clearPane);

  useEffect(() => {
    retainDraftThread(draftId);
    return () => releaseDraftThread(draftId);
  }, [draftId, releaseDraftThread, retainDraftThread]);

  useEffect(() => {
    if (draftSession || !useComposerDraftStore.persist.hasHydrated()) return;
    clearPane(workspaceKey, index);
  }, [clearPane, draftSession, index, workspaceKey]);

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) return;
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (draftSession?.promotedTo) {
      assignThread(workspaceKey, draftSession.promotedTo, index);
    }
  }, [assignThread, draftSession?.promotedTo, index, workspaceKey]);

  if (!draftSession) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
        Restoring composer…
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

function WorkspacePane({
  workspaceKey,
  index,
  paneTarget,
  projectKey,
  projects,
  availableThreads,
  focused,
  maximized,
  rearrangeable,
  style,
  composerHandleRef,
  settleThread,
}: {
  readonly workspaceKey: string;
  readonly index: WorkspacePaneIndex;
  readonly paneTarget: WorkspacePaneTarget | null;
  readonly projectKey: string | null;
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly availableThreads: readonly WorkspaceThreadPickerItem[];
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly rearrangeable: boolean;
  readonly style: CSSProperties;
  readonly composerHandleRef: RefObject<ChatComposerHandle | null>;
  readonly settleThread: ReturnType<typeof useThreadActions>["settleThread"];
}) {
  const focusPane = useWorkspacePaneStore((state) => state.focusPane);
  const clearPane = useWorkspacePaneStore((state) => state.clearPane);
  const setPaneProject = useWorkspacePaneStore((state) => state.setPaneProject);
  const assignThread = useWorkspacePaneStore((state) => state.assignThread);
  const assignDraft = useWorkspacePaneStore((state) => state.assignDraft);
  const toggleMaximize = useWorkspacePaneStore((state) => state.toggleMaximize);
  const swapPanes = useWorkspacePaneStore((state) => state.swapPanes);
  const handleNewThread = useNewThreadHandler();
  const [pendingProjectRef, setPendingProjectRef] = useState<ScopedProjectRef | null>(null);
  const [settling, setSettling] = useState(false);
  const [draggingPane, setDraggingPane] = useState(false);
  const [paneDropActive, setPaneDropActive] = useState(false);
  const draftRequestVersionRef = useRef(0);
  const serverThreadRef = paneTarget && "threadId" in paneTarget ? paneTarget : null;
  const serverThreadShell = useThreadShell(serverThreadRef);
  const openFreshDraft = useCallback(
    (projectRef: ScopedProjectRef) => {
      const requestVersion = ++draftRequestVersionRef.current;
      const freshDraft = { draftId: newDraftId(), threadId: newThreadId() };
      void handleNewThread(projectRef, { navigate: false, freshDraft }).then((opened) => {
        if (draftRequestVersionRef.current === requestVersion && opened) {
          assignDraft(workspaceKey, opened.draftId, index);
        }
      });
    },
    [assignDraft, handleNewThread, index, workspaceKey],
  );
  const selectProject = useCallback(
    (projectRef: ScopedProjectRef) => {
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
      setPaneProject(workspaceKey, index, project.projectKey);
      openFreshDraft(projectRef);
    },
    [index, openFreshDraft, projects, setPaneProject, workspaceKey],
  );
  const openProjectPicker = useCallback(
    () => openCommandPalette({ open: "add-local-project", onProjectSelected: selectProject }),
    [selectProject],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.projectKey === projectKey) ?? null,
    [projectKey, projects],
  );
  const pickerThreads = useMemo(
    () =>
      workspaceThreadPickerItemsForProject(availableThreads, selectedProject?.projectKey ?? null),
    [availableThreads, selectedProject?.projectKey],
  );

  useEffect(() => {
    if (pendingProjectRef) {
      selectProject(pendingProjectRef);
    }
  }, [pendingProjectRef, selectProject]);

  const startNewThread = useCallback(() => {
    if (selectedProject) {
      openFreshDraft(scopeProjectRef(selectedProject.environmentId, selectedProject.id));
    }
  }, [openFreshDraft, selectedProject]);
  const openExistingThread = useCallback(
    (thread: WorkspaceThreadPickerItem) => {
      draftRequestVersionRef.current += 1;
      setPaneProject(workspaceKey, index, thread.projectKey);
      assignThread(workspaceKey, thread.threadRef, index);
    },
    [assignThread, index, setPaneProject, workspaceKey],
  );
  const handleClearPane = useCallback(() => {
    // Invalidate a project selection that is still preparing its draft so it
    // cannot repopulate the pane after the user clears it.
    draftRequestVersionRef.current += 1;
    clearPane(workspaceKey, index);
  }, [clearPane, index, workspaceKey]);
  const settleAvailable =
    serverThreadShell !== null && canSettle(serverThreadShell, { now: new Date().toISOString() });
  const finishThread = useCallback(async () => {
    if (!serverThreadRef || settling) return;
    setSettling(true);
    const result = await settleThread(serverThreadRef);
    setSettling(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not finish thread",
          description: error instanceof Error ? error.message : "The thread was not settled.",
        }),
      );
      return;
    }
    clearPane(workspaceKey, index);
  }, [clearPane, index, serverThreadRef, settleThread, settling, workspaceKey]);

  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background",
        focused ? "z-10 border-primary ring-1 ring-primary/50" : "border-border",
      )}
      style={style}
      aria-label={`Workspace pane ${index + 1}`}
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
        className={cn(
          "flex h-7 shrink-0 items-center border-b px-2 text-[11px] font-medium",
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
            <TooltipPopup side="bottom">Drag onto another pane to swap</TooltipPopup>
          </Tooltip>
        ) : null}
        {projects.length === 0 ? (
          <button
            type="button"
            className="flex h-5 min-w-0 max-w-[45%] items-center gap-1.5 truncate rounded px-1.5 text-left text-[11px] text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={openProjectPicker}
          >
            <FolderOpenIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">Choose project</span>
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex h-5 min-w-0 max-w-[45%] items-center gap-1 rounded px-1.5 text-left text-[11px] text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Change project for pane ${index + 1}`}
            >
              <span className="truncate">{selectedProject?.displayName ?? "Choose project"}</span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Project for this pane</DropdownMenuLabel>
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.projectKey}
                    className={
                      project.projectKey === projectKey ? "bg-foreground/[0.08]" : undefined
                    }
                    onClick={() =>
                      selectProject(scopeProjectRef(project.environmentId, project.id))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.displayName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {project.workspaceRoot}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {projectKey !== null ? (
                <DropdownMenuItem onClick={() => setPaneProject(workspaceKey, index, null)}>
                  Clear project
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={openProjectPicker}>
                <FolderOpenIcon />
                Add project or directory…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="mx-1 shrink-0 text-border" aria-hidden>
          /
        </span>
        {paneTarget && "threadId" in paneTarget ? (
          <WorkspacePaneThreadTitle threadRef={paneTarget} />
        ) : paneTarget ? (
          <WorkspacePaneDraftTitle draftId={paneTarget.draftId} />
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {serverThreadRef ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label="Settle thread and clear pane"
              title={
                settleAvailable ? "Settle thread and clear pane" : "Thread still needs attention"
              }
              disabled={settling || !settleAvailable}
              onClick={() => void finishThread()}
            >
              <CircleCheckIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={maximized ? "Restore pane" : "Maximize pane"}
            title={maximized ? "Restore pane" : "Maximize pane"}
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
              aria-label="Remove from pane — thread keeps running"
              title="Remove from pane — thread keeps running"
              onClick={handleClearPane}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
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
        <EmptyWorkspacePane
          paneNumber={index + 1}
          projectSelected={selectedProject !== null}
          threads={pickerThreads}
          onNewThread={selectedProject ? startNewThread : null}
          onSelectThread={openExistingThread}
        />
      )}
    </section>
  );
}

export function ProjectPaneWorkspace({
  workspaceKey,
  active = true,
}: {
  readonly workspaceKey: string;
  readonly active?: boolean;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { isMacosDesktop, isWindowFullscreen } = useDesktopFullscreen();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const nowMinute = useNowMinute();
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const layout = useWorkspacePaneStore((state) =>
    selectProjectWorkspaceLayout(state, workspaceKey),
  );
  const setPaneCount = useWorkspacePaneStore((state) => state.setPaneCount);
  const setLayoutMode = useWorkspacePaneStore((state) => state.setLayoutMode);
  const resetWorkspace = useWorkspacePaneStore((state) => state.resetWorkspace);
  const { settleThread } = useThreadActions();
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
      key: workspacePaneRenderKey(paneTarget, index),
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
  const settledThreadKeys = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    return new Set(
      threads.flatMap((thread) => {
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        if (capabilities?.threadSettlement !== true) return [];
        if (capabilities.threadSnooze === true && effectiveSnoozed(thread, { now })) return [];
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        const threadKey = scopedThreadKey(threadRef);
        return thread.settledOverride === "settled" ? [threadKey] : [];
      }),
    );
  }, [nowMinute, serverConfigs, threads]);
  const availableThreads = useMemo(
    () =>
      buildWorkspaceThreadPickerItems({
        threads,
        projects: projectGroups,
        paneTargets: panes,
        settledThreadKeys,
      }),
    [panes, projectGroups, settledThreadKeys, threads],
  );
  const paneComposerHandleRefs = useRef(
    Array.from(
      { length: WORKSPACE_PANE_COUNT },
      () => ({ current: null }) as RefObject<ChatComposerHandle | null>,
    ),
  ).current;
  const openWorkspaceWindow = useCallback(() => {
    const nextWorkspace = window.crypto.randomUUID();
    // Electron routes with hash history, so the workspace id must live in the
    // fragment or the new window falls back to the shared "main" workspace.
    const path = `/workspace?workspace=${encodeURIComponent(nextWorkspace)}`;
    window.open(isElectron ? `/#${path}` : path, "_blank");
  }, []);

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
    <SidebarInset className="flex h-svh min-h-0 flex-col overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {isMacosDesktop && !isWindowFullscreen ? (
        <header className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-[var(--workspace-titlebar-content-left)]">
          <div className="min-w-0 flex-1" aria-hidden />
          <div
            className="flex items-center gap-1 [-webkit-app-region:no-drag]"
            aria-label="Workspace layout controls"
          >
            <div className="relative h-6 w-[4.75rem] shrink-0 text-[11px]">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground">
                Panes
              </span>
              <select
                aria-label="Number of panes"
                className="h-6 w-full appearance-none rounded-md border border-border bg-background pr-5 pl-[2.65rem] text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
            {(
              [
                ["grid", Grid2X2Icon, "Grid layout"],
                ["columns", Columns3Icon, "Column layout"],
                ["rows", Rows3Icon, "Row layout"],
              ] as const
            ).map(([mode, Icon, label]) => (
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
            ))}
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label="Reset workspace"
              title="Reset workspace"
              onClick={() => resetWorkspace(workspaceKey)}
            >
              <RotateCcwIcon className="size-3" />
            </Button>
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label="Open workspace in new window"
              title="Open workspace in new window"
              onClick={openWorkspaceWindow}
            >
              <SquareArrowOutUpRightIcon className="size-3" />
            </Button>
          </div>
        </header>
      ) : null}
      <DiffWorkerPoolProvider>
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
                projectKey={projectKeys[index] ?? null}
                projects={projectGroups}
                availableThreads={availableThreads}
                focused={active && focusedPaneIndex === index}
                maximized={maximizedPaneIndex === index}
                rearrangeable={maximizedPaneIndex === null && paneCount > 1}
                style={{
                  order: index,
                  gridRow:
                    index === 0 && leadPaneRowSpan > 1 ? `span ${leadPaneRowSpan}` : undefined,
                }}
                composerHandleRef={paneComposerHandleRefs[index]!}
                settleThread={settleThread}
              />
            );
          })}
        </main>
      </DiffWorkerPoolProvider>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/workspace")({
  validateSearch: (search: Record<string, unknown>) => ({
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  component: () => null,
});
