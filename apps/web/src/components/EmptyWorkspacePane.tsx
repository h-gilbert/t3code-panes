import { useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  CalendarClockIcon,
  CircleCheckIcon,
  MessageSquareDashedIcon,
  FolderPlusIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarThreadStatus } from "./Sidebar.logic";
import {
  filterWorkspaceThreadPickerItems,
  type WorkspaceThreadPickerItem,
} from "../workspacePaneThreadPicker";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { Input } from "./ui/input";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/menu";

const ROW =
  "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const ACTIVITY: Record<SidebarThreadStatus, { label: string; dot: string }> = {
  preparing: { label: msg("Setting up"), dot: "bg-primary" },
  working: { label: msg("Running"), dot: "bg-primary" },
  approval: { label: msg("Needs approval"), dot: "bg-warning" },
  input: { label: msg("Needs input"), dot: "bg-warning" },
  request: { label: msg("Guest request"), dot: "bg-guest" },
  failed: { label: msg("Failed"), dot: "bg-destructive" },
  limited: { label: msg("Usage limit"), dot: "bg-warning" },
  waiting: { label: msg("Waiting"), dot: "bg-muted-foreground" },
  ready: { label: msg("Open", { $context: "thread status" }), dot: "bg-muted-foreground/50" },
};

const STATUS_FILTERS = [
  ["all", msg("All")],
  ["open", msg("Open", { $context: "thread status filter" })],
  ["settled", msg("History")],
] as const;

export function EmptyWorkspacePane({
  projects,
  hiddenProjects,
  selectedProjectKey,
  threads,
  onSelectProject,
  onShowAll,
  onHideProject,
  onAddProject,
  onNewThread,
  scratchEnvironments,
  onSelectThread,
}: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly hiddenProjects: readonly SidebarProjectSnapshot[];
  readonly selectedProjectKey: string | null;
  readonly threads: readonly WorkspaceThreadPickerItem[];
  readonly onSelectProject: (project: SidebarProjectSnapshot) => void;
  readonly onShowAll: () => void;
  readonly onHideProject: (project: SidebarProjectSnapshot) => void;
  readonly onAddProject: () => void;
  readonly scratchEnvironments: readonly EnvironmentOption[];
  readonly onNewThread: (
    project: SidebarProjectSnapshot | null,
    environmentId?: EnvironmentId,
  ) => void;
  readonly onSelectThread: (thread: WorkspaceThreadPickerItem) => void;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const [projectQuery, setProjectQuery] = useState("");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [filter, setFilter] = useState<"all" | "open" | "settled">("all");
  const [showingScheduled, setShowingScheduled] = useState(false);
  const [prevSelectedProjectKey, setPrevSelectedProjectKey] = useState(selectedProjectKey);
  if (prevSelectedProjectKey !== selectedProjectKey) {
    setPrevSelectedProjectKey(selectedProjectKey);
    if (selectedProjectKey !== null) setShowingScheduled(false);
  }
  const now = useNowMinute();
  const selected = showingScheduled
    ? undefined
    : [...projects, ...hiddenProjects].find((project) => project.projectKey === selectedProjectKey);
  const allProjects = !showingScheduled && selected === undefined;
  const crossProject = showingScheduled || allProjects;
  const openCountByProject = new Map<string, number>();
  let openCount = 0;
  let scheduledOpenCount = 0;
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    if (thread.scheduled) {
      scheduledOpenCount++;
      continue;
    }
    openCount++;
    openCountByProject.set(thread.projectKey, (openCountByProject.get(thread.projectKey) ?? 0) + 1);
  }
  const scratchProject = [...projects, ...hiddenProjects].find((project) => project.isScratch);
  const hideableProjects = hiddenProjects.filter((project) => !project.isScratch);
  const matchingProjects = projects.filter(
    (project) =>
      !project.isScratch &&
      `${project.displayName} ${project.workspaceRoot}`
        .toLowerCase()
        .includes(projectQuery.trim().toLowerCase()),
  );
  const scoped = threads.filter((thread) =>
    showingScheduled
      ? thread.scheduled
      : !thread.scheduled && (allProjects || thread.projectKey === selectedProjectKey),
  );
  const scopedOpenCount = scoped.filter((thread) => thread.status === "open").length;
  const scopedSettledCount = scoped.filter((thread) => thread.status === "settled").length;
  const visible = filterWorkspaceThreadPickerItems(threads, {
    projectKey: allProjects ? null : selectedProjectKey,
    scheduled: showingScheduled,
    status: filter,
    query,
  });
  const ordered = [
    ...visible.filter((thread) => thread.status === "open"),
    ...visible.filter((thread) => thread.status === "settled"),
  ];
  const page = ordered.slice(0, visibleLimit);
  const openThreads = page.filter((thread) => thread.status === "open");
  const history = page.filter((thread) => thread.status === "settled");
  const chooseProject = (project: SidebarProjectSnapshot) => {
    setVisibleLimit(100);
    setQuery("");
    setFilter("all");
    setShowingScheduled(false);
    onSelectProject(project);
  };
  const showAll = () => {
    setVisibleLimit(100);
    setQuery("");
    setFilter("all");
    setShowingScheduled(false);
    onShowAll();
  };
  const showScheduled = () => {
    setVisibleLimit(100);
    setQuery("");
    setFilter("all");
    setShowingScheduled(true);
    onShowAll();
  };
  const scratchEnvironmentItems = (project: SidebarProjectSnapshot | null) => (
    <>
      {" "}
      {scratchEnvironments.map((environment) => (
        <DropdownMenuItem
          key={environment.environmentId}
          disabled={environment.disabledReason !== undefined}
          onClick={() => onNewThread(project, environment.environmentId)}
        >
          <EnvironmentMachineIcon kind={environment.machine} className="size-4 shrink-0" />
          {environment.label}
          {environment.disabledReason ? (
            <span className="text-muted-foreground">{environment.disabledReason}</span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
  const renderScratchProject = (project: SidebarProjectSnapshot | null) => (
    <div
      key="scratch"
      className="group flex shrink-0 items-center rounded-md @lg/thread-browser:w-full"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button type="button" />}
          className={cn(
            ROW,
            "min-w-0 flex-1",
            !showingScheduled &&
              project?.projectKey === selectedProjectKey &&
              "bg-primary/10 text-primary",
          )}
          aria-label={gt("No project")}
        >
          <MessageSquareDashedIcon className="size-4 shrink-0" aria-hidden />
          <span className="truncate text-xs font-medium">
            <T>No project</T>
          </span>
          <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
            {project ? (openCountByProject.get(project.projectKey) ?? 0) : 0}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {project ? (
            <>
              <DropdownMenuItem onClick={() => chooseProject(project)}>
                <T>Browse threads</T>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <T>New thread on</T>
            </DropdownMenuLabel>
            {scratchEnvironmentItems(project)}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {newThreadButton(project, true)}
    </div>
  );
  const newThreadButton = (project: SidebarProjectSnapshot | null, iconOnly = false) => {
    const button = (
      <Button
        variant={iconOnly ? "ghost-muted" : "default"}
        size={iconOnly ? "icon-micro" : "compact"}
        aria-label={gt("New thread in {projectName}", {
          projectName: project?.displayName ?? gt("No project"),
        })}
        {...(project && !project.isScratch ? { onClick: () => onNewThread(project) } : {})}
      >
        <PlusIcon aria-hidden />
        {iconOnly ? null : project ? <T>New thread</T> : <T>No project</T>}
      </Button>
    );
    return !project || project.isScratch ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={button} />
        <DropdownMenuContent align="start">{scratchEnvironmentItems(project)}</DropdownMenuContent>
      </DropdownMenu>
    ) : (
      button
    );
  };
  const renderProject = (project: SidebarProjectSnapshot) => (
    <div
      key={project.projectKey}
      className={cn(
        "group flex shrink-0 items-center rounded-md @lg/thread-browser:w-full",
        !showingScheduled &&
          project.projectKey === selectedProjectKey &&
          "bg-primary/10 text-primary",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          className={cn(ROW, "min-w-0 flex-1")}
          aria-label={gt("Show threads in {projectName}", { projectName: project.displayName })}
          aria-pressed={!showingScheduled && project.projectKey === selectedProjectKey}
          onClick={() => chooseProject(project)}
        >
          <ProjectFavicon project={project} className="size-4 shrink-0" />
          <span className="truncate text-xs font-medium">{project.displayName}</span>
          <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
            {openCountByProject.get(project.projectKey) ?? 0}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {project.displayName}
          <br />
          {project.workspaceRoot}
        </TooltipPopup>
      </Tooltip>
      {newThreadButton(project, true)}
      {!project.isScratch ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost-muted" size="icon-micro" />}
            aria-label={gt("Actions for {projectName}", { projectName: project.displayName })}
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onHideProject(project)}>
              <T>Hide project from this list</T>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
  const renderThreads = (items: readonly WorkspaceThreadPickerItem[]) =>
    items.map((thread) => {
      const activity = ACTIVITY[thread.activity];
      return (
        <Tooltip key={`${thread.threadRef.environmentId}:${thread.threadRef.threadId}`}>
          <TooltipTrigger
            render={<button type="button" />}
            className={cn(
              ROW,
              "group w-full gap-3 border-b border-border/50 rounded-none px-4 py-3 @lg/thread-browser:px-5",
            )}
            onClick={() => onSelectThread(thread)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              {thread.status === "settled" ? (
                <CircleCheckIcon className="size-4 text-muted-foreground/60" />
              ) : (
                <span className={cn("size-1.5 rounded-full", activity.dot)} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {thread.title}
              </span>
              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                {crossProject ? (
                  <span className="truncate">
                    {thread.projectName}
                    <span aria-hidden> · </span>
                  </span>
                ) : null}
                <span className="truncate">{thread.environmentLabel}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">
                  {thread.status === "settled" ? <T>Settled</T> : resolveMessage(activity.label)}
                </span>
                {thread.runningSubagentCount > 0 ? (
                  <span className="truncate">
                    {gt(
                      "· {count, plural, one {{count} agent running} other {{count} agents running}}",
                      { count: thread.runningSubagentCount },
                    )}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1 text-2xs text-muted-foreground">
              {thread.paneIndex !== null ? (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  <T>
                    Pane <Var>{thread.paneIndex + 1}</Var>
                  </T>
                </span>
              ) : null}
              <time dateTime={thread.updatedAt}>
                {formatRelativeTimeLabel(thread.updatedAt, Date.parse(`${now}:00.000Z`))}
              </time>
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {thread.paneIndex !== null
              ? gt("Focus {threadTitle} in pane {paneNumber}", {
                  threadTitle: thread.title,
                  paneNumber: thread.paneIndex + 1,
                })
              : thread.title}
          </TooltipPopup>
        </Tooltip>
      );
    });

  return (
    <div className="@container/thread-browser flex min-h-0 flex-1 overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @lg/thread-browser:flex-row">
        <nav
          aria-label={gt("Projects")}
          className="flex shrink-0 flex-col border-b border-border bg-muted/20 @lg/thread-browser:w-48 @lg/thread-browser:min-h-0 @lg/thread-browser:border-b-0 @lg/thread-browser:border-r @3xl/thread-browser:w-56"
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2 @lg/thread-browser:pt-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              <T>Projects</T>
            </span>
            <div className="flex items-center gap-1">
              {hideableProjects.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost-muted" size="icon-xs" />}
                    aria-label={gt("Hidden projects ({count})", { count: hideableProjects.length })}
                  >
                    <MoreHorizontalIcon aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {hideableProjects.map((project) => (
                      <DropdownMenuItem
                        key={project.projectKey}
                        onClick={() => chooseProject(project)}
                      >
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                        <T>
                          Show <Var>{project.displayName}</Var>
                        </T>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={gt("Add project or directory")}
                title={gt("Add project or directory")}
                onClick={onAddProject}
              >
                <FolderPlusIcon aria-hidden />
              </Button>
            </div>
          </div>
          <div className="px-3 py-2">
            <Input
              size="compact"
              type="search"
              aria-label={gt("Find project")}
              placeholder={gt("Find project…")}
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
            />
          </div>
          <div className="flex shrink-0 flex-wrap gap-1 px-2 pb-2 @lg/thread-browser:flex-col @lg/thread-browser:flex-nowrap">
            <button
              type="button"
              className={cn(
                ROW,
                "shrink-0 @lg/thread-browser:w-full",
                allProjects && "bg-primary/10 text-primary",
              )}
              aria-pressed={allProjects}
              onClick={showAll}
            >
              <LayersIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap text-xs font-medium @lg/thread-browser:flex-1">
                <T>All threads</T>
              </span>
              <span className="text-2xs tabular-nums text-muted-foreground">{openCount}</span>
            </button>
            <button
              type="button"
              className={cn(
                ROW,
                "shrink-0 @lg/thread-browser:w-full",
                showingScheduled && "bg-primary/10 text-primary",
              )}
              aria-pressed={showingScheduled}
              onClick={showScheduled}
            >
              <CalendarClockIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap text-xs font-medium @lg/thread-browser:flex-1">
                <T>Scheduled</T>
              </span>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {scheduledOpenCount}
              </span>
            </button>
            {renderScratchProject(scratchProject ?? null)}
          </div>
          <div className="hidden mx-4 border-t border-border @lg/thread-browser:block" />
          <div className="flex gap-1 overflow-x-auto px-2 py-2 @lg/thread-browser:min-h-0 @lg/thread-browser:flex-1 @lg/thread-browser:flex-col @lg/thread-browser:overflow-y-auto @lg/thread-browser:overflow-x-hidden">
            {matchingProjects.map(renderProject)}
            {matchingProjects.length === 0 && projectQuery ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                <T>No matching projects.</T>
              </p>
            ) : null}
          </div>
        </nav>
        <section aria-label={gt("Thread browser")} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4 @lg/thread-browser:px-5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold tracking-tight">
                {showingScheduled ? (
                  <T>Scheduled</T>
                ) : (
                  (selected?.displayName ?? <T>All threads</T>)
                )}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {crossProject
                  ? gt(
                      "{openCount} open · {settledCount} settled across connected projects and machines",
                      { openCount: scopedOpenCount, settledCount: scopedSettledCount },
                    )
                  : gt("{openCount} open · {settledCount} settled", {
                      openCount: scopedOpenCount,
                      settledCount: scopedSettledCount,
                    })}
              </p>
            </div>
            {selected ? newThreadButton(selected) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 pb-3 @lg/thread-browser:px-5">
            <div className="min-w-32 flex-1">
              <Input
                size="compact"
                type="search"
                aria-label={gt("Search threads")}
                placeholder={
                  crossProject ? gt("Search threads or projects…") : gt("Search threads…")
                }
                value={query}
                onChange={(event) => {
                  setVisibleLimit(100);
                  setQuery(event.target.value);
                }}
              />
            </div>
            <div
              className="flex items-center gap-0.5"
              role="group"
              aria-label={gt("Thread status")}
            >
              {STATUS_FILTERS.map(([value, label]) => (
                <Button
                  key={value}
                  variant={filter === value ? "secondary" : "ghost-muted"}
                  size="compact"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setVisibleLimit(100);
                    setFilter(value);
                  }}
                >
                  {resolveMessage(label)}
                </Button>
              ))}
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            aria-label={gt("Threads")}
          >
            {openThreads.length > 0 ? <div>{renderThreads(openThreads)}</div> : null}
            {history.length > 0 ? (
              <div>
                <h3 className="sticky top-0 border-y border-border bg-muted px-4 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground @lg/thread-browser:px-5">
                  <T>History</T>{" "}
                  <span className="ml-1 tabular-nums">
                    {visible.filter((thread) => thread.status === "settled").length}
                  </span>
                </h3>
                {renderThreads(history)}
              </div>
            ) : null}
            {visible.length > visibleLimit ? (
              <div className="flex justify-center p-3">
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => setVisibleLimit(visibleLimit + 100)}
                >
                  <T>Show more threads</T>
                </Button>
              </div>
            ) : null}
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <SearchIcon className="size-5 text-muted-foreground/50" aria-hidden />
                <p className="text-sm font-medium">
                  {query
                    ? gt("No matching threads")
                    : filter === "settled"
                      ? showingScheduled
                        ? gt("No settled scheduled threads yet")
                        : gt("No settled threads yet")
                      : filter === "open"
                        ? showingScheduled
                          ? gt("No open scheduled threads")
                          : gt("No open threads")
                        : showingScheduled
                          ? gt("No scheduled threads yet")
                          : gt("No threads yet")}
                </p>
                <p className="max-w-64 text-xs leading-5 text-muted-foreground">
                  {query
                    ? gt("Try another title, project, or machine.")
                    : showingScheduled
                      ? gt("Threads started by or linked to scheduled tasks appear here.")
                      : selected
                        ? gt("Start a new thread in this project to get going.")
                        : gt("Choose a project to start a thread or browse its history.")}
                </p>
                {query ? (
                  <Button size="compact" variant="ghost" onClick={() => setQuery("")}>
                    <T>Clear search</T>
                  </Button>
                ) : projects.length === 0 ? (
                  <Button size="compact" variant="outline" onClick={onAddProject}>
                    <FolderPlusIcon aria-hidden />
                    <T>Add project</T>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2 text-2xs text-muted-foreground @lg/thread-browser:px-5">
            <span>
              {gt("{count, plural, one {{count} thread} other {{count} threads}}", {
                count: visible.length,
              })}
            </span>
            <span className="truncate">
              <T>Select a thread to open it</T>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
