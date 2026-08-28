/**
 * Projects the shell read model into the shape the notifier reducer expects.
 *
 * The shell stream carries every thread in every environment, which is what a
 * global notifier needs. It also carries the projected fallback stamp and
 * assistant preview, so background threads notify with a summary line too.
 * Loaded thread detail still wins where it exists: it scopes the summary to
 * the turn that just finished.
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
 * has loaded, keyed by thread id; threads missing from it fall back to the
 * shell's own projected summary and fallback stamp.
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
        fallbackEngagedAt:
          (detail ? lastFallbackEngagedAt(detail) : null) ?? shell.lastFallbackEngagedAt ?? null,
        summary:
          (detail ? lastAssistantText(detail, turnId) : null) ??
          shell.latestAssistantSummary ??
          null,
      } satisfies ThreadNotificationSnapshot;
    });
}
