import { makeThreadFixture } from "../../test-fixtures";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_REASONING_EFFORT,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  setModelSelection: null as ((value: unknown) => Promise<AtomCommandResult<void, unknown>>) | null,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (value: unknown) => mocks.setModelSelection?.(value)) as never,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: { threadId: string }) => shellAtom(ref.threadId)) as never,
    },
  };
});

import { render } from "../../../test/render";
import { deriveEffectiveComposerModelState, useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useComposerSelection } from "./useComposerSelection";

// Kept alive so a shell set before the hook mounts is still there when it saves a pick.
const shellAtom = Atom.family((_threadId: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

function setup() {
  const setModelSelection = vi.fn<(value: unknown) => Promise<AtomCommandResult<void, unknown>>>();
  mocks.setModelSelection = setModelSelection;
  return { setModelSelection };
}

const environmentId = EnvironmentId.make("environment-local");
const cursor = ProviderInstanceId.make("cursor");
const stored = createModelSelection(cursor, "claude-opus-5-5", [{ id: "effort", value: "medium" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: cursor,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "auto-smart", name: "Auto", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

// The hook reads only the thread's identity and stored selection.
function cursorThread(id: string) {
  return { environmentId, id: ThreadId.make(id), modelSelection: stored } as EnvironmentThreadShell;
}

function Picker(props: {
  thread: EnvironmentThreadShell;
  runtime: Parameters<typeof useComposerSelection>[0]["activeRuntime"];
  model?: string;
}) {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <button
      type="button"
      onClick={() => onProviderModelSelectStable(cursor, props.model ?? stored.model)}
    >
      Pick the model
    </button>
  );
}

it("keeps a Cursor thread's stored model and options when the user re-picks its unavailable row", async () => {
  setup();
  const thread = cursorThread("thread-cursor");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.modelSelectionByProvider[cursor] ?? thread.modelSelection).toEqual(stored);
  });
});

it("switches back to the thread's stored model while the session runs on another instance", async () => {
  setup();
  const thread = cursorThread("thread-cursor-handoff");
  const runtime = { providerInstanceId: ProviderInstanceId.make("codex") } as Parameters<
    typeof useComposerSelection
  >[0]["activeRuntime"];
  await using _screen = await render(<Picker thread={thread} runtime={runtime} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.activeProvider).toBe(cursor);
    expect(
      deriveEffectiveComposerModelState({
        draft,
        threadStarted: true,
        providers,
        selectedProvider: ProviderDriverKind.make("cursor"),
        selectedInstanceId: cursor,
        threadModelSelection: thread.modelSelection,
        projectModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ selectedModel: stored.model, modelOptions: { [cursor]: stored.options } });
  });
});

it("saves a re-picked model again when its first save failed", async () => {
  const { setModelSelection } = setup();
  setModelSelection
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
    .mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-retry");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  const pick = page.getByRole("button", { name: "Pick the model" });
  await pick.click();
  await vi.waitFor(() => expect(setModelSelection).toHaveBeenCalledTimes(1));
  await pick.click();

  const autoSave = expect.objectContaining({
    input: {
      threadId: thread.id,
      modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
    },
  });
  await vi.waitFor(() => expect(setModelSelection.mock.calls).toEqual([[autoSave], [autoSave]]));
});

it("saves a pick of a seeded model the started thread does not show", async () => {
  const { setModelSelection } = setup();
  setModelSelection.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-seeded");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  useComposerDraftStore
    .getState()
    .setModelSelection(
      scopeThreadRef(environmentId, thread.id),
      createModelSelection(cursor, "auto-smart"),
    );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() =>
    expect(setModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          threadId: thread.id,
          modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
        },
      }),
    ),
  );
});

function setupAccessMode() {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const thread = makeThreadFixture();
  const target = { environmentId: thread.environmentId, threadId: thread.id };
  const providers: ServerProvider[] = ["codex", "claudeAgent"].map((driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: `${driver}-model`, name: driver, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  }));
  const settings = { ...DEFAULT_UNIFIED_SETTINGS, defaultRuntimeMode: "full-access" as const };
  function View() {
    const runtimeMode = useComposerDraftStore(
      (store) => store.getComposerDraft(target)?.runtimeMode ?? settings.defaultRuntimeMode,
    );
    const selection = useComposerSelection({
      environmentId: thread.environmentId,
      composerDraftTarget: target,
      draftThread: null,
      activeThread: thread,
      activeRuntime: null,
      activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
      settings,
      providerStatuses: providers,
      lockedProvider: null,
      supportsProviderSwitchingViaHandoff: true,
      multipleModelSelections: null,
      runtimeMode,
      isLocalDraftThread: false,
      canOverrideServerThreadEnvMode: false,
      setPendingServerThreadEnvModeEntry: () => {},
      setPendingServerThreadStartFromOriginByThreadId: () => {},
      scheduleComposerFocus: () => {},
    });
    return (
      <>
        <output>{runtimeMode}</output>
        {providers.map((provider) => (
          <button
            key={provider.instanceId}
            onClick={() =>
              selection.onProviderModelSelectStable(provider.instanceId, `${provider.driver}-model`)
            }
          >
            {provider.driver}
          </button>
        ))}
        <button onClick={() => selection.handleRuntimeModeChangeStable("approval-required")}>
          Require approval
        </button>
      </>
    );
  }
  return { View, target };
}

it("preserves default and explicitly chosen access when switching provider models", async () => {
  const { View, target } = setupAccessMode();
  await using screen = await render(<View />);
  await screen.getByRole("button", { name: "claudeAgent", exact: true }).click();
  await expect.element(screen.getByText("full-access", { exact: true })).toBeVisible();
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.modelSelectionByProvider[
      ProviderInstanceId.make("claudeAgent")
    ],
  ).toMatchObject({
    model: "claudeAgent-model",
    options: [{ id: "effort", value: DEFAULT_PROVIDER_REASONING_EFFORT }],
  });
  await screen.getByRole("button", { name: "codex", exact: true }).click();
  await expect.element(screen.getByText("full-access", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Require approval", exact: true }).click();
  await screen.getByRole("button", { name: "claudeAgent", exact: true }).click();
  await expect.element(screen.getByText("approval-required", { exact: true })).toBeVisible();
});
