import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    // Vite's base, so route matching ignores the prefix the hosted deployment
    // serves under and every build keeps the same route paths.
    basepath: import.meta.env.BASE_URL,
    context: {},
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
