import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

const detail: PullRequestDetailView = {
  provider: "github",
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

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function render(value = detail) {
  return (
    <PullRequestSummaryTab
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      activityPending={false}
      activityError={null}
      actionPending={false}
      onCommentAction={async () => ({ commentPosted: true })}
      onRefresh={() => {}}
    />
  );
}

function heading(title: string) {
  const section = renderer.root
    .findAllByType("section")
    .find((section) => section.props["aria-label"] === title)!;
  return section
    .findAllByType("button")
    .find((button) => button.findAllByType("span").some((span) => span.children.includes(title)))!;
}

function click(title: string) {
  act(() =>
    heading(title).props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }),
  );
}

it("toggles checks and resets the expanded list for another pull request", () => {
  act(() => {
    renderer = create(render());
  });
  expect(
    renderer.root.findAllByType("span").some((span) => span.children.includes("Unit tests")),
  ).toBe(false);
  act(() => renderer.root.findByProps({ "aria-label": "Show checks" }).props.onClick());
  expect(
    renderer.root.findAllByType("span").some((span) => span.children.includes("Unit tests")),
  ).toBe(true);
  act(() => renderer.root.findByProps({ "aria-label": "Hide checks" }).props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Show checks" }).props["aria-expanded"]).toBe(
    false,
  );
  act(() => renderer.root.findByProps({ "aria-label": "Show checks" }).props.onClick());
  act(() =>
    renderer.update(render({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 })),
  );
  expect(renderer.root.findByProps({ "aria-label": "Show checks" }).props["aria-expanded"]).toBe(
    false,
  );
});

it("keeps an unsaved description while another section is collapsed and reopened", () => {
  act(() => {
    renderer = create(render());
  });
  act(() => renderer.root.findByProps({ "aria-label": "Edit description" }).props.onClick());
  act(() =>
    renderer.root.findByProps({ "aria-label": "Pull request description" }).props.onChange({
      target: { value: "Unsaved description" },
      currentTarget: { value: "Unsaved description" },
      nativeEvent: {},
    }),
  );
  click("Comments");
  expect(heading("Comments").props["aria-expanded"]).toBe(false);
  click("Comments");
  expect(renderer.root.findByProps({ "aria-label": "Pull request description" }).props.value).toBe(
    "Unsaved description",
  );
});
