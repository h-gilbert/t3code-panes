import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useChatGitStatus } from "./useChatGitStatus";

const vcs = vi.hoisted(() => ({ status: vi.fn(), refresh: vi.fn() }));
vi.mock("../state/vcs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/vcs")>()),
  vcsEnvironment: {
    status: vcs.status,
    refreshStatus: { label: "vcsRefreshStatus", run: vcs.refresh },
  },
}));

const environmentId = EnvironmentId.make("test");

function ChatStatus({ mutationId }: { readonly mutationId: string | null }) {
  useChatGitStatus({ environmentId, cwd: "/repo", threadKey: "thread", mutationId });
  return null;
}

it("refreshes the checkout through the RPC and keeps the status subscription mounted", async () => {
  vcs.status.mockReset();
  vcs.refresh.mockReset();
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const status = Atom.make((get) => {
    subscribe();
    get.addFinalizer(unsubscribe);
    return AsyncResult.initial();
  });
  vcs.status.mockReturnValue(status);
  vcs.refresh.mockImplementation(() => Effect.void);
  const registry = AtomRegistry.make();
  const element = (mutationId: string | null) => (
    <RegistryContext.Provider value={registry}>
      <ChatStatus mutationId={mutationId} />
    </RegistryContext.Provider>
  );

  try {
    // Hook-only harness; does not read router context.
    await using screen = await render(element(null), { router: false });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(vcs.refresh).not.toHaveBeenCalled();

    await screen.rerender(element("command-completed"));
    await screen.rerender(element("command-completed"));
    expect(vcs.refresh).toHaveBeenCalledExactlyOnceWith(registry, {
      environmentId,
      input: { cwd: "/repo", localOnly: true },
    });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});
