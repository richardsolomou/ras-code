import type { ScopedThreadRef } from "@ras-code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { planThreadOpen, useChatPaneStore } from "../chatPaneStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useRoutedThreadRef } from "./useRoutedThreadRef";

export function useOpenThreadInPane(): (threadRef: ScopedThreadRef) => Promise<void> {
  const navigate = useNavigate();
  const routed = useRoutedThreadRef();

  return useCallback(
    async (threadRef) => {
      const paneState = useChatPaneStore.getState();
      const plan = planThreadOpen({ layout: paneState, routed, target: threadRef });
      if (plan.layout !== paneState) {
        paneState.applyLayout(plan.layout);
      }
      if (!plan.navigateTo) return;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(plan.navigateTo),
      });
    },
    [navigate, routed],
  );
}
