import { useLocation, useParams } from "@tanstack/react-router";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import {
  DEFAULT_WORKSPACE_KEY,
  isWorkspacePath,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
} from "../workspacePaneStore";

export function useCurrentThreadTarget(): ThreadRouteTarget | null {
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const location = useLocation();
  const workspace =
    typeof location.search.workspace === "string"
      ? location.search.workspace
      : DEFAULT_WORKSPACE_KEY;
  const paneTarget = useWorkspacePaneStore((state) => {
    if (!isWorkspacePath(location.pathname)) return null;
    const layout = selectProjectWorkspaceLayout(state, workspace);
    return layout.panes[layout.focusedPaneIndex] ?? null;
  });
  return paneTarget
    ? "draftId" in paneTarget
      ? { kind: "draft", draftId: paneTarget.draftId }
      : { kind: "server", threadRef: paneTarget }
    : routeTarget;
}
