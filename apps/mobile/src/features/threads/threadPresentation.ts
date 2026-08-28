import type { LampState } from "../../components/StatusLamp";
import type { OrchestrationLatestTurn, OrchestrationSession } from "@ras-code/contracts";
import { EnvironmentThreadShell } from "@ras-code/client-runtime/state/shell";

export function threadSortValue(thread: EnvironmentThreadShell): number {
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(candidate) ? 0 : candidate;
}

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready";

export interface ThreadStatusPresentation {
  readonly kind: ThreadStatusKind;
  readonly label: string;
  readonly lamp: LampState;
}

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  return session.status !== "running";
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      lamp: "waiting",
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      lamp: "waiting",
    };
  }

  if (thread.session?.status === "running") {
    return {
      kind: "working",
      label: "Working",
      lamp: "working",
    };
  }

  if (thread.session?.status === "starting") {
    return {
      kind: "connecting",
      label: "Connecting",
      lamp: "working",
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      lamp: "failed",
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      lamp: "waiting",
    };
  }

  return null;
}
