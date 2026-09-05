/**
 * Drives local notifications from the shell read model.
 *
 * Renders nothing. Every state change re-runs the pure reducer, which is what
 * keeps this free of timers: there is nothing to poll, only transitions to
 * react to.
 */
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import {
  initialNotifierState,
  reduceNotifications,
  countThreadsAwaitingUser,
  type NotifierState,
} from "@t3tools/client-runtime/notifications";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";

import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadDetail,
  useThreadShells,
  findThreadRef,
} from "~/state/entities";
import { useClientSettings } from "~/hooks/useSettings";
import { useOpenThreadInPane } from "~/hooks/useOpenThreadInPane";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { selectFocusedThread, useChatPaneStore } from "~/chatPaneStore";
import { buildNotificationSnapshots } from "./snapshots";
import { playNotificationSound, setBadgeCount, showNotification } from "./deliver";
import { useWindowFocused } from "./useWindowFocused";

const NO_DETAILS: ReadonlyMap<string, EnvironmentThread> = new Map();

export function NotificationCoordinator() {
  const settings = useClientSettings((clientSettings) => clientSettings.notifications);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const windowFocused = useWindowFocused();
  const openThreadInPane = useOpenThreadInPane();

  const routeThreadRef = resolveThreadRouteRef(
    useParams({ strict: false, select: (params) => params }),
  );
  const activeThreadRef = useChatPaneStore((state) => selectFocusedThread(state, routeThreadRef));
  const activeThreadDetail = useThreadDetail(activeThreadRef);

  const details = useMemo(
    () =>
      activeThreadDetail === null
        ? NO_DETAILS
        : new Map([[activeThreadDetail.id, activeThreadDetail]]),
    [activeThreadDetail],
  );

  const snapshots = useMemo(
    () => buildNotificationSnapshots({ threads, projects, details }),
    [details, projects, threads],
  );

  const stateRef = useRef<NotifierState>(initialNotifierState);

  const openThread = useEffectEvent((threadId: string) => {
    const ref = findThreadRef(threadId as ThreadId);
    if (ref === null) return;
    void openThreadInPane(ref);
  });

  useEffect(() => {
    // The shell stream replays everything it missed on connect. Feeding the
    // reducer only once the catch-up is done makes the first snapshot a
    // baseline rather than a burst of notifications about old work.
    if (!bootstrapped) return;

    const { state, notifications } = reduceNotifications({
      state: stateRef.current,
      snapshots,
      settings,
      context: { activeThreadId: activeThreadRef?.threadId ?? null, windowFocused },
    });
    stateRef.current = state;

    for (const notification of notifications) {
      showNotification({
        notification,
        silent: !settings.sound,
        onActivate: () => openThread(notification.threadId),
      });
    }
    if (notifications.length > 0 && settings.sound) {
      playNotificationSound();
    }
  }, [activeThreadRef?.threadId, bootstrapped, settings, snapshots, windowFocused]);

  useEffect(() => {
    setBadgeCount(settings.enabled ? countThreadsAwaitingUser(snapshots) : 0);
  }, [settings.enabled, snapshots]);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onNotificationActivated;
    if (typeof subscribe !== "function") return;
    return subscribe((threadId) => {
      openThread(threadId);
    });
  }, []);

  return null;
}
