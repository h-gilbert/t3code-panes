import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { useWorkspacePaneStore } from "../workspacePaneStore";
import { readCurrentWorkspaceTarget } from "./currentWorkspaceTarget";

it("reads the focused pane at command time and keeps workspace windows independent", () => {
  const store = useWorkspacePaneStore.getState();
  const first = { environmentId: EnvironmentId.make("one"), threadId: ThreadId.make("first") };
  const second = { environmentId: EnvironmentId.make("two"), threadId: ThreadId.make("second") };
  const router = (workspace: string) =>
    ({
      state: { location: { pathname: "/workspace", search: { workspace } }, matches: [] },
    }) as unknown as AnyRouter;
  try {
    store.setPaneCount("command-window-one", 2);
    store.assignThread("command-window-one", first, 0);
    store.assignThread("command-window-one", second, 1);
    store.assignThread("command-window-two", first, 0);
    store.focusPane("command-window-one", 1);
    expect(readCurrentWorkspaceTarget(router("command-window-one"))).toEqual({
      kind: "server",
      threadRef: second,
    });
    expect(readCurrentWorkspaceTarget(router("command-window-two"))).toEqual({
      kind: "server",
      threadRef: first,
    });
    store.focusPane("command-window-one", 0);
    expect(readCurrentWorkspaceTarget(router("command-window-one"))).toEqual({
      kind: "server",
      threadRef: first,
    });
  } finally {
    store.resetWorkspace("command-window-one");
    store.resetWorkspace("command-window-two");
  }
});
