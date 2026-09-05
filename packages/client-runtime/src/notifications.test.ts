import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "@t3tools/contracts";

import {
  countThreadsAwaitingUser,
  initialNotifierState,
  reduceNotifications,
  type NotificationContext,
  type NotifierState,
  type ThreadNotificationSnapshot,
} from "./notifications.ts";

const UNFOCUSED: NotificationContext = { activeThreadId: null, windowFocused: false };

function thread(overrides: Partial<ThreadNotificationSnapshot> = {}): ThreadNotificationSnapshot {
  return {
    threadId: "thread-1",
    threadTitle: "Fix the sidebar",
    projectName: "ras-code",
    turnId: "turn-1",
    turnStatus: "running",
    awaitingApproval: false,
    awaitingUserInput: false,
    fallbackEngagedAt: null,
    summary: null,
    ...overrides,
  };
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return { ...DEFAULT_NOTIFICATION_SETTINGS, ...overrides };
}

/** Establishes a baseline, the way a client does on its first state read. */
function baseline(snapshots: ReadonlyArray<ThreadNotificationSnapshot>): NotifierState {
  return reduceNotifications({
    state: initialNotifierState,
    snapshots,
    settings: settings(),
    context: UNFOCUSED,
  }).state;
}

function run(input: {
  state: NotifierState;
  snapshots: ReadonlyArray<ThreadNotificationSnapshot>;
  settings?: NotificationSettings;
  context?: NotificationContext;
}) {
  return reduceNotifications({
    state: input.state,
    snapshots: input.snapshots,
    settings: input.settings ?? settings(),
    context: input.context ?? UNFOCUSED,
  });
}

describe("reduceNotifications replay suppression", () => {
  it("says nothing about threads it is seeing for the first time", () => {
    const { notifications } = run({
      state: initialNotifierState,
      snapshots: [
        thread({ turnStatus: "completed" }),
        thread({ threadId: "t2", awaitingApproval: true }),
      ],
    });
    expect(notifications).toEqual([]);
  });

  it("notifies about a transition observed after the baseline", () => {
    const state = baseline([thread()]);
    const { notifications } = run({ state, snapshots: [thread({ turnStatus: "completed" })] });
    expect(notifications.map((entry) => entry.kind)).toEqual(["turnCompleted"]);
  });

  it("re-baselines a thread that disappeared and came back", () => {
    const state = run({ state: baseline([thread()]), snapshots: [] }).state;
    const { notifications } = run({ state, snapshots: [thread({ turnStatus: "completed" })] });
    expect(notifications).toEqual([]);
  });
});

describe("reduceNotifications transitions", () => {
  it("notifies once per turn even when the snapshot repeats", () => {
    const state = baseline([thread()]);
    const first = run({ state, snapshots: [thread({ turnStatus: "completed" })] });
    const second = run({ state: first.state, snapshots: [thread({ turnStatus: "completed" })] });
    expect(first.notifications).toHaveLength(1);
    expect(second.notifications).toEqual([]);
  });

  it("notifies again when the next turn completes", () => {
    const state = baseline([thread()]);
    const first = run({ state, snapshots: [thread({ turnStatus: "completed" })] });
    const { notifications } = run({
      state: first.state,
      snapshots: [thread({ turnId: "turn-2", turnStatus: "completed" })],
    });
    expect(notifications.map((entry) => entry.kind)).toEqual(["turnCompleted"]);
  });

  it("notifies about a failed turn", () => {
    const state = baseline([thread()]);
    const { notifications } = run({ state, snapshots: [thread({ turnStatus: "failed" })] });
    expect(notifications.map((entry) => entry.kind)).toEqual(["turnFailed"]);
  });

  it("notifies when an approval opens, and not while it stays open", () => {
    const state = baseline([thread()]);
    const opened = run({ state, snapshots: [thread({ awaitingApproval: true })] });
    const stillOpen = run({ state: opened.state, snapshots: [thread({ awaitingApproval: true })] });
    expect(opened.notifications.map((entry) => entry.kind)).toEqual(["approvalRequested"]);
    expect(stillOpen.notifications).toEqual([]);
  });

  it("notifies about a second approval opened in the same turn", () => {
    const opened = run({
      state: baseline([thread()]),
      snapshots: [thread({ awaitingApproval: true })],
    });
    const resolved = run({ state: opened.state, snapshots: [thread()] });
    const reopened = run({
      state: resolved.state,
      snapshots: [thread({ awaitingApproval: true })],
    });
    expect(reopened.notifications.map((entry) => entry.kind)).toEqual(["approvalRequested"]);
  });

  it("notifies when the agent asks the user a question", () => {
    const state = baseline([thread()]);
    const { notifications } = run({ state, snapshots: [thread({ awaitingUserInput: true })] });
    expect(notifications.map((entry) => entry.kind)).toEqual(["userInputRequested"]);
  });

  it("notifies about each distinct fallback, not about the same one twice", () => {
    const state = baseline([thread()]);
    const engaged = run({
      state,
      snapshots: [thread({ fallbackEngagedAt: "2026-01-01T00:00:00.000Z" })],
      settings: settings({
        events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, fallbackEngaged: true },
      }),
    });
    const repeated = run({
      state: engaged.state,
      snapshots: [thread({ fallbackEngagedAt: "2026-01-01T00:00:00.000Z" })],
      settings: settings({
        events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, fallbackEngaged: true },
      }),
    });
    expect(engaged.notifications.map((entry) => entry.kind)).toEqual(["fallbackEngaged"]);
    expect(repeated.notifications).toEqual([]);
  });

  it("uses a short assistant summary as the completed-turn body", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ turnStatus: "completed", summary: "  Renamed  the helper.  " })],
    });
    expect(notifications[0]?.body).toBe("Renamed the helper.");
  });

  it("falls back to the thread and project when the summary is long", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ turnStatus: "completed", summary: "x".repeat(200) })],
    });
    expect(notifications[0]?.body).toBe("Fix the sidebar · ras-code");
  });
});

describe("reduceNotifications settings toggles", () => {
  it("stays silent for every event when notifications are off", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [
        thread({ turnStatus: "completed", awaitingApproval: true, awaitingUserInput: true }),
      ],
      settings: settings({ enabled: false }),
    });
    expect(notifications).toEqual([]);
  });

  it.each([
    ["turnCompleted", thread({ turnStatus: "completed" })],
    ["turnFailed", thread({ turnStatus: "failed" })],
    ["approvalRequested", thread({ awaitingApproval: true })],
    ["userInputRequested", thread({ awaitingUserInput: true })],
    ["fallbackEngaged", thread({ fallbackEngagedAt: "2026-01-01T00:00:00.000Z" })],
  ] as const)("drops %s when its toggle is off", (kind, snapshot) => {
    const state = baseline([thread()]);
    const allOn = { ...DEFAULT_NOTIFICATION_SETTINGS.events, fallbackEngaged: true };
    const withKindOff = run({
      state,
      snapshots: [snapshot],
      settings: settings({ events: { ...allOn, [kind]: false } }),
    });
    const withKindOn = run({
      state,
      snapshots: [snapshot],
      settings: settings({ events: allOn }),
    });
    expect(withKindOff.notifications).toEqual([]);
    expect(withKindOn.notifications.map((entry) => entry.kind)).toContain(kind);
  });

  it("keeps fallback notifications off by default", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ fallbackEngagedAt: "2026-01-01T00:00:00.000Z" })],
    });
    expect(notifications).toEqual([]);
  });
});

describe("reduceNotifications focus suppression", () => {
  it("stays silent about the thread on screen while the window has focus", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ turnStatus: "completed" })],
      context: { activeThreadId: "thread-1", windowFocused: true },
    });
    expect(notifications).toEqual([]);
  });

  it("notifies about another thread when only-when-unfocused is off", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ turnStatus: "completed" })],
      settings: settings({ onlyWhenUnfocused: false }),
      context: { activeThreadId: "other-thread", windowFocused: true },
    });
    expect(notifications.map((entry) => entry.kind)).toEqual(["turnCompleted"]);
  });

  it("stays silent about another thread while only-when-unfocused is on", () => {
    const state = baseline([thread()]);
    const { notifications } = run({
      state,
      snapshots: [thread({ turnStatus: "completed" })],
      context: { activeThreadId: "other-thread", windowFocused: true },
    });
    expect(notifications).toEqual([]);
  });

  it("does not resurface a suppressed transition once the window loses focus", () => {
    const state = baseline([thread()]);
    const suppressed = run({
      state,
      snapshots: [thread({ turnStatus: "completed" })],
      context: { activeThreadId: "thread-1", windowFocused: true },
    });
    const afterBlur = run({
      state: suppressed.state,
      snapshots: [thread({ turnStatus: "completed" })],
    });
    expect(afterBlur.notifications).toEqual([]);
  });
});

describe("countThreadsAwaitingUser", () => {
  it("counts each thread waiting on an approval or an answer once", () => {
    expect(
      countThreadsAwaitingUser([
        thread({ threadId: "a", awaitingApproval: true, awaitingUserInput: true }),
        thread({ threadId: "b", awaitingUserInput: true }),
        thread({ threadId: "c" }),
      ]),
    ).toBe(2);
  });
});
