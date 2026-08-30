import type { ScopedThreadRef } from "@ras-code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import {
  openDraftInFocusedPane,
  planThreadOpen,
  useChatPaneStore,
  type FocusedPane,
} from "../chatPaneStore";
import type { DraftId } from "../composerDraftStore";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { useRoutedThreadRef } from "./useRoutedThreadRef";

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

  return useCallback(
    (draftId, options) =>
      openDraftInFocusedPane(
        draftId,
        () =>
          navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(draftId),
            ...(options?.replace !== undefined ? { replace: options.replace } : {}),
          }),
        options?.pane,
      ),
    [navigate],
  );
}
