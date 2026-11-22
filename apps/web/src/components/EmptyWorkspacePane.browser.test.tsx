import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { WorkspaceThreadPickerItem } from "../workspacePaneThreadPicker";
import { EmptyWorkspacePane } from "./EmptyWorkspacePane";

const environmentId = EnvironmentId.make("local");
const clocktowerId = ProjectId.make("clocktower");
const traindId = ProjectId.make("traind");

function project(id: ProjectId, projectKey: string, displayName: string): SidebarProjectSnapshot {
  return {
    id,
    environmentId,
    title: displayName,
    cwd: `/workspace/${projectKey}`,
    workspaceRoot: `/workspace/${projectKey}`,
    isScratch: false,
    projectKey,
    displayName,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [],
    memberProjectRefs: [scopeProjectRef(environmentId, id)],
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  } as unknown as SidebarProjectSnapshot;
}

const projects: readonly SidebarProjectSnapshot[] = [
  project(clocktowerId, "clocktower", "Clocktower"),
  project(traindId, "traind", "TRAIND"),
];

const threads: readonly WorkspaceThreadPickerItem[] = [
  {
    threadRef: scopeThreadRef(environmentId, ThreadId.make("manual-open")),
    title: "Ship checkout redesign",
    projectKey: "clocktower",
    projectName: "Clocktower",
    status: "open",
    scheduled: false,
    runningSubagentCount: 0,
    paneIndex: null,
    environmentLabel: "Jeff",
    updatedAt: "2026-11-22T07:50:00.000Z",
    activity: "ready",
  },
  {
    threadRef: scopeThreadRef(environmentId, ThreadId.make("sched-running")),
    title: "STAMP Weekly Search & AI Visibility Review",
    projectKey: "clocktower",
    projectName: "Clocktower",
    status: "open",
    scheduled: true,
    runningSubagentCount: 0,
    paneIndex: null,
    environmentLabel: "Jeff",
    updatedAt: "2026-11-22T07:58:00.000Z",
    activity: "working",
  },
  {
    threadRef: scopeThreadRef(environmentId, ThreadId.make("sched-settled")),
    title: "TRAIND coach: weekly review",
    projectKey: "traind",
    projectName: "TRAIND",
    status: "settled",
    scheduled: true,
    runningSubagentCount: 0,
    paneIndex: null,
    environmentLabel: "Jeff",
    updatedAt: "2026-11-21T20:00:00.000Z",
    activity: "ready",
  },
];

describe("EmptyWorkspacePane", () => {
  it("keeps scheduled threads in their own Scheduled area with separate counts", async () => {
    const onSelectProject = vi.fn();
    const onShowAll = vi.fn();
    const onSelectThread = vi.fn();
    const baseProps = {
      projects,
      hiddenProjects: [],
      selectedProjectKey: null as string | null,
      threads,
      onSelectProject,
      onShowAll,
      onHideProject: vi.fn(),
      onAddProject: vi.fn(),
      scratchEnvironments: [],
      onNewThread: vi.fn(),
      onSelectThread,
    };

    // router: false -- EmptyWorkspacePane only uses callback props and has no router hooks.
    await using screen = await render(<EmptyWorkspacePane {...baseProps} />, { router: false });

    const allButton = screen.getByRole("button", { name: /All threads/ });
    const scheduledButton = screen.getByRole("button", { name: /Scheduled/ });
    const clocktowerButton = screen.getByRole("button", { name: "Show threads in Clocktower" });

    await expect.element(allButton).toHaveTextContent("All threads1");
    await expect.element(scheduledButton).toHaveTextContent("Scheduled1");
    await expect.element(clocktowerButton).toHaveTextContent("Clocktower1");
    await expect.element(screen.getByText("Ship checkout redesign")).toBeVisible();
    await expect
      .element(screen.getByText("STAMP Weekly Search & AI Visibility Review"))
      .not.toBeInTheDocument();

    await userEvent.click(scheduledButton);

    await expect.element(screen.getByRole("heading", { name: "Scheduled" })).toBeVisible();
    await expect
      .element(screen.getByText("1 open · 1 settled across connected projects and machines"))
      .toBeVisible();
    await expect
      .element(screen.getByText("STAMP Weekly Search & AI Visibility Review"))
      .toBeVisible();
    await expect.element(screen.getByText("TRAIND coach: weekly review")).toBeVisible();
    await expect.element(screen.getByText("Ship checkout redesign")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("STAMP Weekly Search & AI Visibility Review"));
    expect(onSelectThread).toHaveBeenCalledWith(threads[1]);

    await userEvent.click(clocktowerButton);
    expect(onSelectProject).toHaveBeenCalledWith(projects[0]);

    await screen.rerender(<EmptyWorkspacePane {...baseProps} selectedProjectKey="clocktower" />);
    await expect.element(screen.getByRole("heading", { name: "Clocktower" })).toBeVisible();
    await expect.element(screen.getByText("Ship checkout redesign")).toBeVisible();
    await expect
      .element(screen.getByText("STAMP Weekly Search & AI Visibility Review"))
      .not.toBeInTheDocument();
  });
});
