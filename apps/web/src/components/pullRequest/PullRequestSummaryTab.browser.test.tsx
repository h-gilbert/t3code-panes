import {
  DEFAULT_CLIENT_SETTINGS,
  SourceControlProviderKind,
  type ClientSettings,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  canUpdate: true,
  timestampFormat: "locale" as "locale" | "12-hour" | "24-hour",
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.update) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select?: (settings: ClientSettings) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: state.timestampFormat };
    return select ? select(settings) : settings;
  }) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      update: {
        ...actual.pullRequestEnvironment.update,
        permissionAtom: () => (state.canUpdate ? allowed : denied),
      },
    },
  };
});

function setup() {
  state.update.mockReset();
  state.update.mockResolvedValue({ _tag: "Success", value: undefined });
  state.canUpdate = true;
  state.timestampFormat = "locale";
}

import { act, render as renderUi } from "../../../test/render";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

const tab = (value = detail) => (
  <PullRequestSummaryTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    threadRef={null}
    reference={value}
    detail={value}
    actionPending={false}
    onCommentAction={async () => ({ commentPosted: true })}
    activityPending={false}
    activityError={null}
    onRefresh={() => {}}
  />
);

async function render(value = detail) {
  const screen = await renderUi(tab(value));
  const { container } = screen;
  const heading = (title: string) => {
    const section = container.querySelector(`section[aria-label="${title}"]`);
    expect(section, `section ${title}`).not.toBeNull();
    return [...section!.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    )!;
  };
  return Object.assign(screen, {
    click: (title: string) => act(async () => heading(title).click()),
    expanded: (title: string) => heading(title).getAttribute("aria-expanded"),
    visibleText: () => container.innerText,
  });
}

it("keeps an unsaved description when collapsed and reopened, and after a failed save", async () => {
  setup();
  state.update.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
  await using screen = await render();
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await screen.click("Comments (0)");
  expect(screen.expanded("Comments (0)")).toBe("false");
  await screen.click("Comments (0)");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");

  await screen.click("Description");
  expect(screen.expanded("Description")).toBe("false");
  await screen.click("Description");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(state.update).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");
});

it("ticks a description checkbox placed after an attachment and edits from the ticked body", async () => {
  setup();
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  const body = "Intro\n\nhttps://example.com/shot.png\n\n## Test plan\n- [ ] First\n- [ ] Second";
  const ticked = body.replace("- [ ] Second", "- [x] Second");
  await using screen = await render({ ...detail, body, observedAt: 1 });
  const boxes = () => screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes()].map((box) => box.disabled)).toEqual([false, false]);

  await userEvent.click(boxes()[1]!);
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "environment",
    input: expect.objectContaining({ number: 1, body: ticked }),
  });
  expect([...boxes()].map((box) => box.checked)).toEqual([false, true]);
  await act(async () => finishSave({ _tag: "Success", value: undefined }));

  // The host has not been read since the save, so the editor starts from the ticked body.
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  expect(screen.container.querySelector("textarea")!.value).toBe(ticked);
});

it("leaves description checkboxes read-only without the right to edit it", async () => {
  setup();
  const body = "- [ ] First";
  {
    await using screen = await render({ ...detail, body, viewer: "someone-else" });
    expect(
      screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    ).toBe(true);
  }
  state.canUpdate = false;
  await using screen = await render({ ...detail, body });
  expect(screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(
    true,
  );
});

it("fixes an overview thread as its opening remark, since it has no line to attach", async () => {
  setup();
  const author = { login: "reviewer", name: null, avatarUrl: null };
  const note = { author, createdAt: "2026-09-01T00:00:00Z", url: null };
  const remark = {
    ...note,
    id: "10",
    kind: "review-comment" as const,
    body: "Mention the flag in the README",
    path: null,
    reviewState: null,
  };
  const onFixFinding = vi.fn();
  const value: PullRequestDetailView = {
    ...detail,
    comments: [remark],
    overviewThreads: [
      {
        id: "overview",
        path: null,
        line: null,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [{ ...note, id: "10", body: remark.body }],
      },
    ],
  };
  await using screen = await renderUi(
    <PullRequestSummaryTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      activityPending={false}
      activityError={null}
      onRefresh={() => {}}
      onFixFinding={onFixFinding}
      actionPending={false}
      onCommentAction={async () => ({ commentPosted: false })}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Fix in a thread" }));
  expect(onFixFinding).toHaveBeenCalledWith({ kind: "comment", comment: remark });
});

it("shows a comment's exact time in the chosen 24-hour clock", async () => {
  setup();
  state.timestampFormat = "24-hour";
  const createdAt = "2026-09-01T17:30:00Z";
  const comment = {
    id: "10",
    kind: "review-comment" as const,
    body: "A remark",
    author: { login: "reviewer", name: null, avatarUrl: null },
    createdAt,
    url: null,
    path: null,
    reviewState: null,
  };
  await using screen = await render({ ...detail, comments: [comment], commentCount: 1 });

  await userEvent.hover(screen.container.querySelector(`time[datetime="${createdAt}"]`)!);
  const expected = new Date(createdAt).toLocaleString(undefined, { hour12: false });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(expected),
  );
});

it("toggles checks and resets the expanded list for another pull request", async () => {
  setup();
  await using screen = await render();
  const showChecks = screen.getByRole("button", { name: "Show checks" });
  const unitTests = screen.getByText("Unit tests", { exact: true });
  await expect.element(unitTests).not.toBeInTheDocument();

  await screen.click("Checks");
  await userEvent.click(showChecks);
  await expect.element(unitTests).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Hide checks" }));
  await expect.element(showChecks).toHaveAttribute("aria-expanded", "false");
  await expect.element(unitTests).not.toBeInTheDocument();

  await userEvent.click(showChecks);
  await screen.rerender(tab({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 }));
  expect(screen.expanded("Checks")).toBe("false");
  await screen.click("Checks");
  await expect.element(showChecks).toHaveAttribute("aria-expanded", "false");
});

it("hides bot and resolved comments until the filter shows them, and remembers the choice", async () => {
  setup();
  const filterKey = "t3code:pull-request-comment-filter:v1";
  const previousFilter = localStorage.getItem(filterKey);
  localStorage.removeItem(filterKey);
  using _storage = {
    [Symbol.dispose]: () =>
      previousFilter === null
        ? localStorage.removeItem(filterKey)
        : localStorage.setItem(filterKey, previousFilter),
  };
  const comment = (index: number, login: string, body: string, isBot = false) => ({
    id: `comment-${index}`,
    kind: "issue-comment" as const,
    author: { login, name: null, avatarUrl: null, isBot },
    body,
    createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}Z`,
    url: null,
    path: null,
    reviewState: null,
  });
  const resolved = {
    ...comment(13, "reviewer", "Resolved remark"),
    kind: "review-comment" as const,
  };
  const value: PullRequestDetailView = {
    ...detail,
    commentCount: 14,
    comments: [
      ...Array.from({ length: 12 }, (_, index) =>
        comment(index, "review-app", `Bot report ${index}`, true),
      ),
      comment(12, "human", "Human comment"),
      resolved,
    ],
    reviewThreads: [
      {
        id: "thread",
        path: "src/index.ts",
        line: 1,
        side: "right",
        isResolved: true,
        isOutdated: false,
        comments: [resolved],
      },
    ],
  };

  {
    await using screen = await render(value);
    const filter = screen.getByRole("button", { name: "Filter comments" });
    const human = screen.getByText("Human comment", { exact: true });
    const botReports = screen.getByText(/^Bot report \d+$/);
    const oldestBotReport = screen.getByText("Bot report 0", { exact: true });
    const resolvedThread = screen.getByRole("button", { name: "Resolved", exact: true });
    await expect.element(human).toBeVisible();
    await expect.element(botReports).not.toBeInTheDocument();
    await expect.element(resolvedThread).not.toBeInTheDocument();
    await expect.element(filter).toHaveTextContent("13 hidden");

    await userEvent.click(filter);
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Bot comments" }));
    await vi.waitFor(() => expect(botReports.all()).toHaveLength(9));
    await expect.element(human).toBeVisible();
    await expect.element(oldestBotReport).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Resolved or dismissed" }));
    await expect.element(resolvedThread).toBeVisible();
    await userEvent.keyboard("{Escape}");
  }

  await using screen = await render({ ...value, url: `${value.url}0`, number: 10 });
  await expect.element(screen.getByText("Bot report 11", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Filter comments" }));
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Bot comments" }))
    .toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
});
