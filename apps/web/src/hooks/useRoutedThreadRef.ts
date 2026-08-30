import type { ScopedThreadRef } from "@ras-code/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";

/**
 * The server thread on screen in the routed pane — the one that owns the URL and
 * the global shortcuts — or null while the route shows an unpromoted draft or no
 * thread at all.
 *
 * A draft route counts once its draft has been promoted, since by then it is
 * showing a real thread.
 */
export function useRoutedThreadRef(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  return useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
}
