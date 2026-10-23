import { useState } from "react";
import {
  CircleCheckIcon,
  FolderPlusIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
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
  DropdownMenuTrigger,
} from "./ui/menu";

const ROW =
  "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const ACTIVITY = {
  working: { label: "Running", dot: "bg-primary" },
  approval: { label: "Needs approval", dot: "bg-warning" },
  input: { label: "Needs input", dot: "bg-warning" },
  failed: { label: "Failed", dot: "bg-destructive" },
  limited: { label: "Usage limit", dot: "bg-warning" },
  waiting: { label: "Waiting", dot: "bg-muted-foreground" },
  ready: { label: "Open", dot: "bg-muted-foreground/50" },
};

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
  readonly onNewThread: (project: SidebarProjectSnapshot) => void;
  readonly onSelectThread: (thread: WorkspaceThreadPickerItem) => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [filter, setFilter] = useState<"all" | "open" | "settled">("all");
  const now = useNowMinute();
  const selected = [...projects, ...hiddenProjects].find(
    (project) => project.projectKey === selectedProjectKey,
  );
  const allProjects = selected === undefined;
  const openCountByProject = new Map<string, number>();
  let openCount = 0;
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    openCount++;
    openCountByProject.set(thread.projectKey, (openCountByProject.get(thread.projectKey) ?? 0) + 1);
  }
  const scratchProjects = [...projects, ...hiddenProjects].filter((project) => project.isScratch);
  const hideableProjects = hiddenProjects.filter((project) => !project.isScratch);
  const matchingProjects = projects.filter(
    (project) =>
      !project.isScratch &&
      `${project.displayName} ${project.workspaceRoot}`
        .toLowerCase()
        .includes(projectQuery.trim().toLowerCase()),
  );
  const scoped = threads.filter((thread) =>
    allProjects ? thread.status === "open" : thread.projectKey === selectedProjectKey,
  );
  const visible = filterWorkspaceThreadPickerItems(threads, {
    projectKey: allProjects ? null : selectedProjectKey,
    status: allProjects ? "open" : filter,
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
    onSelectProject(project);
  };
  const showAll = () => {
    setVisibleLimit(100);
    setQuery("");
    setFilter("all");
    onShowAll();
  };
  const renderProject = (project: SidebarProjectSnapshot) => (
    <div
      key={project.projectKey}
      className={cn(
        "group flex shrink-0 items-center rounded-md @lg/thread-browser:w-full",
        project.projectKey === selectedProjectKey && "bg-primary/10 text-primary",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          className={cn(ROW, "min-w-0 flex-1")}
          aria-label={`Show threads in ${project.displayName}`}
          aria-pressed={project.projectKey === selectedProjectKey}
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
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`New thread in ${project.displayName}`}
        onClick={() => onNewThread(project)}
      >
        <PlusIcon aria-hidden />
      </Button>
      {!project.isScratch ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost-muted" size="icon-micro" />}
            aria-label={`Actions for ${project.displayName}`}
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onHideProject(project)}>
              Hide project from this list
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
                {allProjects ? (
                  <span className="truncate">
                    {thread.projectName}
                    <span aria-hidden> · </span>
                  </span>
                ) : null}
                <span className="truncate">{thread.environmentLabel}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">
                  {thread.status === "settled" ? "Settled" : activity.label}
                </span>
                {thread.runningSubagentCount > 0 ? (
                  <span className="truncate">· {thread.runningSubagentCount} agents running</span>
                ) : null}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1 text-2xs text-muted-foreground">
              {thread.paneIndex !== null ? (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  Pane {thread.paneIndex + 1}
                </span>
              ) : null}
              <time dateTime={thread.updatedAt}>
                {formatRelativeTimeLabel(thread.updatedAt, Date.parse(`${now}:00.000Z`))}
              </time>
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {thread.paneIndex !== null
              ? `Focus ${thread.title} in pane ${thread.paneIndex + 1}`
              : thread.title}
          </TooltipPopup>
        </Tooltip>
      );
    });

  return (
    <div className="@container/thread-browser flex min-h-0 flex-1 overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @lg/thread-browser:flex-row">
        <nav
          aria-label="Projects"
          className="flex shrink-0 flex-col border-b border-border bg-muted/20 @lg/thread-browser:w-48 @lg/thread-browser:min-h-0 @lg/thread-browser:border-b-0 @lg/thread-browser:border-r @3xl/thread-browser:w-56"
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2 @lg/thread-browser:pt-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Projects
            </span>
            <div className="flex items-center gap-1">
              {hideableProjects.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost-muted" size="icon-xs" />}
                    aria-label={`Hidden projects (${hideableProjects.length})`}
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
                        Show {project.displayName}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Add project or directory"
                title="Add project or directory"
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
              aria-label="Find project"
              placeholder="Find project…"
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
                All open threads
              </span>
              <span className="text-2xs tabular-nums text-muted-foreground">{openCount}</span>
            </button>
            {scratchProjects.map(renderProject)}
          </div>
          <div className="hidden mx-4 border-t border-border @lg/thread-browser:block" />
          <div className="flex gap-1 overflow-x-auto px-2 py-2 @lg/thread-browser:min-h-0 @lg/thread-browser:flex-1 @lg/thread-browser:flex-col @lg/thread-browser:overflow-y-auto @lg/thread-browser:overflow-x-hidden">
            {matchingProjects.map(renderProject)}
            {matchingProjects.length === 0 && projectQuery ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">No matching projects.</p>
            ) : null}
          </div>
        </nav>
        <section aria-label="Thread browser" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4 @lg/thread-browser:px-5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold tracking-tight">
                {selected?.displayName ?? "All open threads"}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {allProjects
                  ? "Across connected projects and machines"
                  : `${scoped.filter((thread) => thread.status === "open").length} open · ${scoped.filter((thread) => thread.status === "settled").length} settled`}
              </p>
            </div>
            {selected ? (
              <Button size="compact" onClick={() => onNewThread(selected)}>
                <PlusIcon aria-hidden />
                New thread
              </Button>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 pb-3 @lg/thread-browser:px-5">
            <div className="min-w-32 flex-1">
              <Input
                size="compact"
                type="search"
                aria-label="Search threads"
                placeholder={allProjects ? "Search threads or projects…" : "Search threads…"}
                value={query}
                onChange={(event) => {
                  setVisibleLimit(100);
                  setQuery(event.target.value);
                }}
              />
            </div>
            {!allProjects ? (
              <div className="flex items-center gap-0.5" role="group" aria-label="Thread status">
                {(
                  [
                    ["all", "All"],
                    ["open", "Open"],
                    ["settled", "History"],
                  ] as const
                ).map(([value, label]) => (
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
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Threads">
            {openThreads.length > 0 ? <div>{renderThreads(openThreads)}</div> : null}
            {history.length > 0 ? (
              <div>
                <h3 className="sticky top-0 border-y border-border bg-muted px-4 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground @lg/thread-browser:px-5">
                  History{" "}
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
                  Show more threads
                </Button>
              </div>
            ) : null}
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <SearchIcon className="size-5 text-muted-foreground/50" aria-hidden />
                <p className="text-sm font-medium">
                  {query
                    ? "No matching threads"
                    : filter === "settled" && !allProjects
                      ? "No settled threads yet"
                      : "No open threads"}
                </p>
                <p className="max-w-64 text-xs leading-5 text-muted-foreground">
                  {query
                    ? "Try another title, project, or machine."
                    : selected
                      ? "Start a new thread in this project to get going."
                      : "Choose a project to start a thread or browse its history."}
                </p>
                {query ? (
                  <Button size="compact" variant="ghost" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : projects.length === 0 ? (
                  <Button size="compact" variant="outline" onClick={onAddProject}>
                    <FolderPlusIcon aria-hidden />
                    Add project
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2 text-2xs text-muted-foreground @lg/thread-browser:px-5">
            <span>
              {visible.length} {visible.length === 1 ? "thread" : "threads"}
            </span>
            <span className="truncate">Select a thread to open it</span>
          </div>
        </section>
      </div>
    </div>
  );
}
