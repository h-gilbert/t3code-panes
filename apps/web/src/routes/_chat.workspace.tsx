import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  Columns3Icon,
  FolderOpenIcon,
  Grid2X2Icon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorUpIcon,
  RotateCcwIcon,
  Rows3Icon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

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
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { useThreadDetail, useThreadRefs, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentShell } from "../state/shell";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useClientSettings } from "../hooks/useSettings";
import { useDesktopFullscreen } from "../hooks/useDesktopFullscreen";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
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
  DEFAULT_WORKSPACE_KEY,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
  type WorkspacePaneCount,
  type WorkspacePaneIndex,
  type WorkspacePaneTarget,
} from "../workspacePaneStore";
import {
  resolveWorkspaceDraftThreadRef,
  resolveWorkspacePaneThreadTitle,
} from "../workspacePaneTitle";
import { cn } from "~/lib/utils";
import { newDraftId, newThreadId } from "../lib/utils";

function EmptyWorkspacePane({
  paneNumber,
  projectSelected,
  onNewThread,
}: {
  readonly paneNumber: number;
  readonly projectSelected: boolean;
  readonly onNewThread: (() => void) | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <MonitorUpIcon className="size-6 text-muted-foreground/60" aria-hidden />
      <p className="text-sm font-medium text-foreground">Pane {paneNumber}</p>
      <p className="max-w-64 text-xs leading-5 text-muted-foreground">
        {projectSelected
          ? "Choose a thread from this project in the sidebar."
          : "Choose a project for this pane, then select one of its threads."}
      </p>
      {onNewThread ? (
        <Button size="sm" variant="outline" onClick={onNewThread}>
          New thread
        </Button>
      ) : null}
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
  focused,
  maximized,
  composerHandleRef,
}: {
  readonly workspaceKey: string;
  readonly index: WorkspacePaneIndex;
  readonly paneTarget: WorkspacePaneTarget | null;
  readonly projectKey: string | null;
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly composerHandleRef: RefObject<ChatComposerHandle | null>;
}) {
  const focusPane = useWorkspacePaneStore((state) => state.focusPane);
  const clearPane = useWorkspacePaneStore((state) => state.clearPane);
  const setPaneProject = useWorkspacePaneStore((state) => state.setPaneProject);
  const assignDraft = useWorkspacePaneStore((state) => state.assignDraft);
  const toggleMaximize = useWorkspacePaneStore((state) => state.toggleMaximize);
  const handleNewThread = useNewThreadHandler();
  const [pendingProjectRef, setPendingProjectRef] = useState<ScopedProjectRef | null>(null);
  const draftRequestVersionRef = useRef(0);
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
  const handleClearPane = useCallback(() => {
    // Invalidate a project selection that is still preparing its draft so it
    // cannot repopulate the pane after the user clears it.
    draftRequestVersionRef.current += 1;
    clearPane(workspaceKey, index);
  }, [clearPane, index, workspaceKey]);

  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden border bg-background",
        focused ? "z-10 border-primary ring-1 ring-primary/50" : "border-border",
      )}
      aria-label={`Workspace pane ${index + 1}`}
      data-workspace-pane={index}
      data-focused={focused ? "true" : "false"}
      onPointerDownCapture={() => focusPane(workspaceKey, index)}
    >
      <div
        className={cn(
          "flex h-7 shrink-0 items-center border-b px-2 text-[11px] font-medium",
          focused
            ? "border-primary/40 bg-primary/[0.07] text-foreground"
            : "border-border bg-muted/30 text-muted-foreground",
        )}
        onDoubleClick={() => toggleMaximize(workspaceKey, index)}
      >
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
              aria-label="Clear pane"
              title="Clear pane"
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
          projectSelected={projectKey !== null}
          onNewThread={selectedProject ? startNewThread : null}
        />
      )}
    </section>
  );
}

function ProjectPaneWorkspace() {
  const search = Route.useSearch();
  const workspaceKey = search.workspace ?? DEFAULT_WORKSPACE_KEY;
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { isMacosDesktop, isWindowFullscreen } = useDesktopFullscreen();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
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
  const { panes, projectKeys, paneCount, layoutMode, focusedPaneIndex, maximizedPaneIndex } =
    layout;
  const visiblePanes = panes.slice(0, paneCount);
  const paneComposerHandleRefs = useRef(
    Array.from({ length: 8 }, () => ({ current: null }) as RefObject<ChatComposerHandle | null>),
  ).current;
  const openWorkspaceWindow = useCallback(() => {
    const nextWorkspace = window.crypto.randomUUID();
    window.open(`/workspace?workspace=${encodeURIComponent(nextWorkspace)}`, "_blank");
  }, []);

  useEffect(() => {
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
      const paneCountMatch = /^workspace\.paneCount\.([1-8])$/.exec(command ?? "");
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
                {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((count) => (
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
                      gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(paneCount))}, minmax(0, 1fr))`,
                      gridAutoRows: "minmax(0, 1fr)",
                    }
          }
        >
          {visiblePanes.map((paneTarget, rawIndex) => {
            const index = rawIndex as WorkspacePaneIndex;
            if (maximizedPaneIndex !== null && maximizedPaneIndex !== index) return null;
            return (
              <WorkspacePane
                key={index}
                workspaceKey={workspaceKey}
                index={index}
                paneTarget={paneTarget}
                projectKey={projectKeys[index] ?? null}
                projects={projectGroups}
                focused={focusedPaneIndex === index}
                maximized={maximizedPaneIndex === index}
                composerHandleRef={paneComposerHandleRefs[index]!}
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
  component: ProjectPaneWorkspace,
});
