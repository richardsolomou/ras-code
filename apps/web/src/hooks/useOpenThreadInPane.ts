import type { ScopedThreadRef } from "@ras-code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import {
  openDraftInFocusedPane,
  isCompanionVisible,
  planThreadOpen,
  planRoutedDraftOpen,
  useChatPaneStore,
  type FocusedPane,
} from "../chatPaneStore";
import type { DraftId } from "../composerDraftStore";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { useRoutedThreadRef, useRouteTargetId } from "./useRoutedThreadRef";

export function useOpenThreadInPane(): (threadRef: ScopedThreadRef) => Promise<void> {
  const navigate = useNavigate();
  const routed = useRoutedThreadRef();
  const routedRef = useRef(routed);
  routedRef.current = routed;

  return useCallback(
    async (threadRef) => {
      const paneState = useChatPaneStore.getState();
      const plan = planThreadOpen({
        layout: paneState,
        routed: routedRef.current,
        target: threadRef,
      });
      if (plan.layout !== paneState) {
        paneState.applyLayout(plan.layout);
      }
      if (!plan.navigateTo) return;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(plan.navigateTo),
      });
    },
    [navigate],
  );
}

export function useOpenDraftInPane(): (
  draftId: DraftId,
  options?: { replace?: boolean; pane?: FocusedPane },
) => Promise<void> {
  const navigate = useNavigate();
  const routeId = useRouteTargetId();
  const routeIdRef = useRef(routeId);
  routeIdRef.current = routeId;

  return useCallback(
    (draftId, options) => {
      const paneState = useChatPaneStore.getState();
      const pane =
        options?.pane ?? (isCompanionVisible(paneState) ? paneState.focusedPane : "routed");
      if (routeIdRef.current === `draft:${draftId}`) {
        const nextLayout = planRoutedDraftOpen(paneState, pane);
        if (nextLayout !== paneState) paneState.applyLayout(nextLayout);
        return Promise.resolve();
      }
      return openDraftInFocusedPane(
        draftId,
        () =>
          navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(draftId),
            ...(options?.replace !== undefined ? { replace: options.replace } : {}),
          }),
        pane,
      );
    },
    [navigate],
  );
}
