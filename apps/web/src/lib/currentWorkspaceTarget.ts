import type { AnyRouter } from "@tanstack/react-router";
import { type ThreadRouteTarget, resolveThreadRouteTarget } from "../threadRoutes";
import {
  DEFAULT_WORKSPACE_KEY,
  isWorkspacePath,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
} from "../workspacePaneStore";

export function readCurrentWorkspaceTarget(router: AnyRouter): ThreadRouteTarget | null {
  const location = router.state.location;
  if (location && isWorkspacePath(location.pathname)) {
    const layout = selectProjectWorkspaceLayout(
      useWorkspacePaneStore.getState(),
      location.search?.workspace ?? DEFAULT_WORKSPACE_KEY,
    );
    const target = layout.panes[layout.focusedPaneIndex];
    return target
      ? "draftId" in target
        ? { kind: "draft", draftId: target.draftId }
        : { kind: "server", threadRef: target }
      : null;
  }
  return resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
}
