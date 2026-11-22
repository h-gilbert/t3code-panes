import { createRouter, RouterHistory } from "@tanstack/react-router";

import { delegatesStreamedTabs } from "./env";
import { parseDelegatedDesktopSearch } from "./workspaceRouteSearch";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    ...(delegatesStreamedTabs ? { parseSearch: parseDelegatedDesktopSearch } : {}),
    context: {},
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
