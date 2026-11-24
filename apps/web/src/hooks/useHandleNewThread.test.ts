import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  type ProjectFile = { readonly defaultThreadEnvMode?: "local" | "worktree" } | null;
  let completeProjectFileRead: (value: ProjectFile) => void = () => undefined;
  let projectFileRead = Promise.resolve<ProjectFile>(null);
  let draftSession = {
    envMode: "local",
    worktreePath: null,
    branch: null as string | null,
    environmentSelection: undefined as "manual" | undefined,
  };
  let projectDefaultModel: ModelSelection | null = null;
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null as { instanceId: string; model: string } | null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
    starredModelSelection: null as ModelSelection | null,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  const router = {
    state: {
      location: { href: "/", pathname: "/", search: {} },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
    buildLocation: (request: { readonly params: { readonly draftId: string } }) => ({
      href: `/draft/${request.params.draftId}`,
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(
      (
        _draftId: string,
      ): {
        draftId?: string;
        activeProvider?: string;
        modelSelectionExplicit?: boolean;
        modelSelectionByProvider?: Record<string, { instanceId: string; model: string }>;
      } => ({}),
    ),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      openDraftRoute === null
        ? { ...draftSession, promotedTo: null, startFromOrigin: false }
        : {
            logicalProjectKey: "remote-project",
            promotedTo: null,
            threadId: "thread-open",
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: ProjectFile) => completeProjectFileRead(value),
    discoverBranch(branch: string) {
      draftSession = { ...draftSession, branch };
    },
    keepEarlierManualChoice() {
      draftSession = { ...draftSession, environmentSelection: "manual" };
    },
    pickBranch(branch: string) {
      draftSession = { ...draftSession, branch, environmentSelection: "manual" };
    },
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectDefaultModel() {
      return projectDefaultModel;
    },
    setProjectDefaultModel(selection: ModelSelection) {
      projectDefaultModel = selection;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    openEmptyDraft(draftId: string) {
      openDraftRoute = { kind: "draft", draftId };
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      openDraftRoute = null;
      draftSession = {
        envMode: "local",
        worktreePath: null,
        branch: null,
        environmentSelection: undefined,
      };
      projectDefaultModel = null;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        starredModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setModelSelection.mockClear();
      draftStore.applyStickyState.mockClear();
      draftStore.getComposerDraft.mockReset();
      draftStore.getComposerDraft.mockImplementation((draftId: string) => ({ draftId }));
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<ProjectFile>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: (ref: { environmentId: string; projectId: string }) =>
    `${ref.environmentId}:${ref.projectId}`,
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/contracts")>()),
  DEFAULT_RUNTIME_MODE: "default",
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("@t3tools/shared/projectSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/shared/projectSettings")>();
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...original,
    resolveProjectSettings: (
      settings: Parameters<typeof original.resolveProjectSettings>[0],
      ...rest: [
        Parameters<typeof original.resolveProjectSettings>[1],
        Parameters<typeof original.resolveProjectSettings>[2]?,
        Parameters<typeof original.resolveProjectSettings>[3]?,
      ]
    ) => {
      const merged = { ...DEFAULT_SERVER_SETTINGS, ...settings };
      // Without a project file the hook reads unresolved settings, as it does at runtime.
      return rest[2] === undefined
        ? original.resolveProjectSettings(merged, rest[0], rest[1])
        : original.resolveProjectSettings(merged, rest[0], rest[1], rest[2]);
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react-dom", () => ({ flushSync: (update: () => void) => update() }));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
}));
vi.mock("../providerInstances", () => ({ resolveDefaultProviderModelSelection: () => null }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
  peekT3ProjectFile: () => undefined,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    get defaultModelSelection() {
      return testState.projectDefaultModel;
    },
  };
  return {
    readProjects: () => [project],
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "environment-local" }));
vi.mock("../state/projects", () => ({ defaultProjectFallbackReadyAtom: () => true }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ getClientSettings: () => ({}) }));

import {
  readPendingWorkspaceDefault,
  resolveDefaultProjectRef,
  useNewThreadHandler,
} from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("opens the draft before the project file is read, then applies its workspace default", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ envMode: "local" }),
    );
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.discoverBranch("main");
    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("applies the project file's default to a draft chosen manually before it opened", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    testState.keepEarlierManualChoice();
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("keeps a branch the user picked while the project file loaded", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.pickBranch("feature");
    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await testState.projectFileRead;

    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("useNewThreadHandler", () => {
  it("keeps an explicit machine choice pinned in the created draft", async () => {
    testState.reset(null);
    await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { environmentSelection: "manual" },
    );
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      "draft-delayed",
      expect.objectContaining({ environmentSelection: "manual" }),
    );
  });

  it("preserves an explicit model choice when reusing a draft", async () => {
    testState.reset({
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    });
    testState.draftStore.getComposerDraft.mockReturnValue({
      activeProvider: "claudeAgent",
      modelSelectionExplicit: true,
      modelSelectionByProvider: {
        claudeAgent: { instanceId: "claudeAgent", model: "claude-fable-5" },
      },
    });
    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pendingOpen;
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
  });

  it.each([
    ["new", null],
    [
      "reused",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ] as const)("uses the saved default model for a %s draft", async (_, draft) => {
    testState.reset(draft);
    const savedDefault = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    testState.targetSettings.defaultModelSelection = savedDefault;
    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;
    expect(testState.draftStore.applyStickyState).toHaveBeenCalledWith(opened?.draftId);
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      opened?.draftId,
      savedDefault,
      { replaceOptions: true },
    );
  });

  it("new threads switch from starred Opus to starred Sol with the new thinking budget", async () => {
    for (const selection of [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    ]) {
      testState.reset(null);
      testState.setProjectDefaultModel({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
      });
      testState.targetSettings.starredModelSelection = selection;
      const opened = useNewThreadHandler()({
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never);
      testState.completeProjectFileRead(null);
      const draft = await opened;
      expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
        draft?.draftId,
        selection,
        {
          replaceOptions: true,
        },
      );
    }
  });

  it("keeps the sticky model when there is no saved default or thread to carry from", async () => {
    testState.reset(null);
    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;
    expect(testState.draftStore.applyStickyState).toHaveBeenCalledWith(opened?.draftId);
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
  });

  describe.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("origin settings with a %s draft", (_, draft) => {
    it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
      "uses the target environment's %s permissions for new threads",
      async (runtimeMode) => {
        testState.reset(draft);
        testState.targetSettings.defaultRuntimeMode = runtimeMode;
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;
        const pendingOpen = useNewThreadHandler()(projectRef);
        testState.completeProjectFileRead(null);
        const opened = await pendingOpen;

        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ runtimeMode }),
        );
      },
    );

    it.each([true, false])(
      "uses the target environment's start-from-origin default of %s",
      async (startFromOrigin) => {
        testState.reset(draft, { envMode: "worktree", startFromOrigin });
        const openThread = useNewThreadHandler();
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;
        const pendingOpen = openThread(projectRef);

        testState.completeProjectFileRead(null);
        const opened = await pendingOpen;

        expect(opened).toEqual({
          draftId: draft?.draftId ?? "draft-delayed",
          threadId: draft?.threadId ?? "thread-delayed",
        });
        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
        if (draft) {
          expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
            draft.draftId,
            expect.objectContaining({ envMode: "worktree", startFromOrigin }),
          );
        }
      },
    );

    it.each([true, false])(
      "preserves an explicit start-from-origin choice of %s",
      async (startFromOrigin) => {
        testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
        const openThread = useNewThreadHandler();
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;

        const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
      },
    );
  });
});

describe("useNewThreadHandler", () => {
  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("default project selection", () => {
  it("prefers the last used project in its environment and falls back when unavailable", () => {
    const projects = [
      { id: "project", environmentId: "first", workspaceRoot: "/first" },
      { id: "project", environmentId: "last-used", workspaceRoot: "/last-used" },
    ].map((project) => ({
      ...project,
      id: project.id as ProjectId,
      environmentId: project.environmentId as EnvironmentId,
      title: project.environmentId,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }));
    expect(resolveDefaultProjectRef(projects, [], "last-used:project")).toEqual({
      environmentId: "last-used",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project", false),
    ).toBeNull();
    expect(resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project")).toEqual({
      environmentId: "first",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(
        [projects[0]!, { ...projects[1]!, archivedAt: "2026-11-09T00:00:00.000Z" }],
        [],
        "last-used:project",
      ),
    ).toEqual({ environmentId: "first", projectId: "project" });
  });
});
