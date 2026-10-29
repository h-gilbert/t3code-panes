import {
  DEFAULT_PROVIDER_REASONING_EFFORT,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadFixture } from "../../test-fixtures";
import { useComposerSelection } from "./useComposerSelection";

function setup() {
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
      interactionMode: "default",
      interactionModeEnabled: true,
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
  const { View, target } = setup();
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
