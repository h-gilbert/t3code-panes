import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection, type RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
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
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree",
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
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
      draftStore.getComposerDraft.mockReturnValue({});
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : new Map([
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
        ]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
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
    resolveProjectSettings: (settings: Parameters<typeof original.resolveProjectSettings>[0]) =>
      original.resolveProjectSettings({ ...DEFAULT_SERVER_SETTINGS, ...settings }, null),
  };
});
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
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
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "environment-local" }));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
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

  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(null);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
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
