import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { TooltipProvider } from "~/components/ui/tooltip";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { I18nProvider } from "~/i18n/I18nProvider";
import { getRouter } from "~/router";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("the new-thread project picker follows the manual sidebar project order", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarProjectSortOrder: "manual",
  });
  useUiStateStore.setState({
    projectOrder: [
      `${ENVIRONMENT_ID}:/workspace/beta`,
      `${ENVIRONMENT_ID}:/workspace/render`,
      `${ENVIRONMENT_ID}:/workspace/alpha`,
    ],
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const draftId = DraftId.make("draft-manual-order");
  const projectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId);
  using _draft = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearDraftThread(draftId),
  };

  const router = getRouter(createMemoryHistory({ initialEntries: ["/workspace"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // AppRoot connects the environment. Embedded workspace panes omit this headline.
  await using hero = await render(
    <I18nProvider>
      <AppAtomRegistryProvider>
        <TooltipProvider>
          <DraftHeroHeadline
            draftId={draftId}
            activeProjectRef={projectRef}
            activeProjectTitle="render"
          />
        </TooltipProvider>
      </AppAtomRegistryProvider>
    </I18nProvider>,
  );
  const trigger = hero.getByRole("combobox");
  await expect.element(trigger).toBeVisible();
  await userEvent.click(trigger);
  const betaOption = page.getByRole("option", { name: "beta", exact: true });
  const projectOptions = page.getByRole("listbox").filter({ has: betaOption }).getByRole("option");

  // The draft's own project leads; the rest keep the sidebar's order.
  await vi.waitFor(() => {
    expect(projectOptions.elements().map((option) => option.textContent)).toEqual([
      expect.stringMatching(/render$/),
      expect.stringMatching(/beta$/),
      expect.stringMatching(/alpha$/),
      "Add project",
    ]);
  });
});
