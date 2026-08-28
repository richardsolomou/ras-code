/**
 * Projects the shell read model into the shape the notifier reducer expects.
 *
 * The shell stream carries every thread in every environment, which is what a
 * global notifier needs. It does not carry message text or activities, so the
 * open thread's detail — when the client has it — supplies the summary line
 * and the provider-fallback marker.
 */
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@ras-code/client-runtime/state/models";
import type { ThreadNotificationSnapshot } from "@ras-code/client-runtime/notifications";

import { FALLBACK_ENGAGED_ACTIVITY_KIND } from "~/components/settings/providerUsageLimit.logic";

function turnStatusOf(shell: EnvironmentThreadShell): ThreadNotificationSnapshot["turnStatus"] {
  switch (shell.latestTurn?.state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    // An interrupted turn is the user's own doing, so it reads as idle.
    default:
      return "idle";
  }
}

function lastAssistantText(detail: EnvironmentThread, turnId: string | null): string | null {
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.messages[index];
    if (message === undefined || message.role !== "assistant" || message.streaming) continue;
    if (turnId !== null && message.turnId !== turnId) continue;
    return message.text;
  }
  return null;
}

function lastFallbackEngagedAt(detail: EnvironmentThread): string | null {
  for (let index = detail.activities.length - 1; index >= 0; index -= 1) {
    const activity = detail.activities[index];
    if (activity?.kind === FALLBACK_ENGAGED_ACTIVITY_KIND) return activity.createdAt;
  }
  return null;
}

/**
 * One snapshot per thread. `details` holds whatever thread detail the client
 * has loaded, keyed by thread id; threads missing from it still notify, just
 * without a summary line or a fallback marker.
 */
export function buildNotificationSnapshots(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly details: ReadonlyMap<string, EnvironmentThread>;
}): ReadonlyArray<ThreadNotificationSnapshot> {
  const projectTitles = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );

  return input.threads
    .filter((shell) => shell.archivedAt === null)
    .map((shell) => {
      const detail = input.details.get(shell.id);
      const turnId = shell.latestTurn?.turnId ?? null;
      return {
        threadId: shell.id,
        threadTitle: shell.title,
        projectName: projectTitles.get(`${shell.environmentId}:${shell.projectId}`) ?? "",
        turnId,
        turnStatus: turnStatusOf(shell),
        awaitingApproval: shell.hasPendingApprovals,
        awaitingUserInput: shell.hasPendingUserInput,
        fallbackEngagedAt: detail ? lastFallbackEngagedAt(detail) : null,
        summary: detail ? lastAssistantText(detail, turnId) : null,
      } satisfies ThreadNotificationSnapshot;
    });
}
