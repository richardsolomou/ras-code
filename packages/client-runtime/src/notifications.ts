/**
 * Derives local notifications from thread state transitions.
 *
 * Clients feed a snapshot of every thread they can see on each state change;
 * the reducer compares it against the previous snapshot and returns the
 * notifications worth showing. It is deliberately pure so every surface (web,
 * desktop, and mobile if it ever stops relying on push) shares one set of
 * rules, and so the suppression cases are testable without a browser.
 */
import type { NotificationEventKind, NotificationSettings } from "@t3tools/contracts/settings";

export type { NotificationEventKind };

/**
 * What one thread looks like to the notifier. Clients project their read model
 * into this shape; nothing here is provider- or transport-specific.
 */
export interface ThreadNotificationSnapshot {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectName: string;
  /** Identifies the current turn so a notification fires once per turn. */
  readonly turnId: string | null;
  readonly turnStatus: "idle" | "running" | "completed" | "failed";
  readonly awaitingApproval: boolean;
  readonly awaitingUserInput: boolean;
  /**
   * Timestamp of the most recent `provider.fallback.engaged` activity, or
   * null. A changed non-null value is a new fallback.
   */
  readonly fallbackEngagedAt: string | null;
  /** Last assistant message, when short enough to read in a notification. */
  readonly summary: string | null;
}

export interface NotificationContext {
  /** The thread on screen, or null when the user is somewhere else. */
  readonly activeThreadId: string | null;
  readonly windowFocused: boolean;
}

export interface DerivedNotification {
  readonly kind: NotificationEventKind;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  /** Per thread, turn and kind. Delivery uses it to replace an older toast. */
  readonly dedupeKey: string;
}

/**
 * Opaque carry-over between reductions: the last snapshot of every thread the
 * client could see. Notifications are edge-triggered against it, so a repeated
 * snapshot is silent and the first reduction — against an empty state — only
 * records a baseline, which is what keeps hydration and event replay silent.
 */
export interface NotifierState {
  readonly threads: ReadonlyMap<string, ThreadNotificationSnapshot>;
}

export const initialNotifierState: NotifierState = { threads: new Map() };

/** Longer assistant replies read as noise in a notification body. */
const MAX_SUMMARY_LENGTH = 140;

const EVENT_TITLES: Readonly<Record<NotificationEventKind, string>> = {
  turnCompleted: "Finished",
  turnFailed: "Failed",
  approvalRequested: "Approval needed",
  userInputRequested: "Input needed",
  fallbackEngaged: "Switched provider",
};

function describeThread(snapshot: ThreadNotificationSnapshot): string {
  return snapshot.projectName.length > 0
    ? `${snapshot.threadTitle} · ${snapshot.projectName}`
    : snapshot.threadTitle;
}

function summaryLine(snapshot: ThreadNotificationSnapshot): string | null {
  const summary = snapshot.summary?.replace(/\s+/g, " ").trim() ?? "";
  if (summary.length === 0 || summary.length > MAX_SUMMARY_LENGTH) return null;
  return summary;
}

function turnKey(snapshot: ThreadNotificationSnapshot): string {
  return snapshot.turnId ?? "no-turn";
}

/**
 * Transitions for one thread, before any settings or focus filtering. A thread
 * with no previous snapshot produces nothing: it was either just hydrated or
 * just created, and neither is something the user asked to be told about.
 */
function transitions(
  previous: ThreadNotificationSnapshot | undefined,
  current: ThreadNotificationSnapshot,
): ReadonlyArray<NotificationEventKind> {
  if (!previous) return [];

  const kinds: Array<NotificationEventKind> = [];
  const sameTurn = previous.turnId === current.turnId;

  if (current.turnStatus === "completed" && (previous.turnStatus !== "completed" || !sameTurn)) {
    kinds.push("turnCompleted");
  }
  if (current.turnStatus === "failed" && (previous.turnStatus !== "failed" || !sameTurn)) {
    kinds.push("turnFailed");
  }
  if (current.awaitingApproval && !previous.awaitingApproval) {
    kinds.push("approvalRequested");
  }
  if (current.awaitingUserInput && !previous.awaitingUserInput) {
    kinds.push("userInputRequested");
  }
  if (
    current.fallbackEngagedAt !== null &&
    current.fallbackEngagedAt !== previous.fallbackEngagedAt
  ) {
    kinds.push("fallbackEngaged");
  }

  return kinds;
}

function bodyFor(kind: NotificationEventKind, snapshot: ThreadNotificationSnapshot): string {
  if (kind === "turnCompleted") {
    return summaryLine(snapshot) ?? describeThread(snapshot);
  }
  return describeThread(snapshot);
}

function isSuppressedByFocus(
  kind: NotificationEventKind,
  snapshot: ThreadNotificationSnapshot,
  context: NotificationContext,
  settings: NotificationSettings,
): boolean {
  if (!context.windowFocused) return false;
  // The user is looking at this thread; the UI already shows what happened.
  if (context.activeThreadId === snapshot.threadId) return true;
  return settings.onlyWhenUnfocused;
}

export interface NotifierResult {
  readonly state: NotifierState;
  readonly notifications: ReadonlyArray<DerivedNotification>;
}

/**
 * Folds the latest snapshot of every visible thread into the next notifier
 * state plus the notifications to show now. Threads that disappear are
 * forgotten, so reconnecting to an environment starts from a fresh baseline
 * instead of replaying whatever happened while it was gone.
 */
export function reduceNotifications(input: {
  readonly state: NotifierState;
  readonly snapshots: ReadonlyArray<ThreadNotificationSnapshot>;
  readonly settings: NotificationSettings;
  readonly context: NotificationContext;
}): NotifierResult {
  const { state, snapshots, settings, context } = input;

  const nextThreads = new Map<string, ThreadNotificationSnapshot>();
  const notifications: Array<DerivedNotification> = [];

  for (const snapshot of snapshots) {
    const previous = state.threads.get(snapshot.threadId);
    nextThreads.set(snapshot.threadId, snapshot);

    if (!settings.enabled) continue;

    for (const kind of transitions(previous, snapshot)) {
      if (!settings.events[kind]) continue;

      if (isSuppressedByFocus(kind, snapshot, context, settings)) continue;

      notifications.push({
        kind,
        threadId: snapshot.threadId,
        title: `${EVENT_TITLES[kind]} · ${snapshot.threadTitle}`,
        body: bodyFor(kind, snapshot),
        dedupeKey: `${snapshot.threadId}:${turnKey(snapshot)}:${kind}`,
      });
    }
  }

  return { state: { threads: nextThreads }, notifications };
}

/** Threads the user still has to answer, for a dock or taskbar badge. */
export function countThreadsAwaitingUser(
  snapshots: ReadonlyArray<ThreadNotificationSnapshot>,
): number {
  return snapshots.filter((snapshot) => snapshot.awaitingApproval || snapshot.awaitingUserInput)
    .length;
}
