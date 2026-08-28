import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId, ThreadId } from "@ras-code/contracts";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@ras-code/client-runtime/state/models";

import { FALLBACK_ENGAGED_ACTIVITY_KIND } from "~/components/settings/providerUsageLimit.logic";
import { buildNotificationSnapshots } from "./snapshots";

const ENVIRONMENT_ID = "primary" as EnvironmentId;
const PROJECT_ID = "project-1" as ProjectId;
const THREAD_ID = "thread-1" as ThreadId;

function project(): EnvironmentProject {
  return {
    environmentId: ENVIRONMENT_ID,
    id: PROJECT_ID,
    title: "ras-code",
  } as unknown as EnvironmentProject;
}

function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: ENVIRONMENT_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the sidebar",
    latestTurn: { turnId: "turn-1", state: "running" },
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function detail(overrides: Partial<EnvironmentThread> = {}): EnvironmentThread {
  return {
    environmentId: ENVIRONMENT_ID,
    id: THREAD_ID,
    messages: [],
    activities: [],
    ...overrides,
  } as unknown as EnvironmentThread;
}

function build(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  details?: ReadonlyMap<string, EnvironmentThread>;
}) {
  return buildNotificationSnapshots({
    threads: input.threads,
    projects: [project()],
    details: input.details ?? new Map(),
  });
}

describe("buildNotificationSnapshots", () => {
  it("names the thread's project", () => {
    expect(build({ threads: [shell()] })[0]?.projectName).toBe("ras-code");
  });

  it.each([
    ["running", "running"],
    ["completed", "completed"],
    ["error", "failed"],
    ["interrupted", "idle"],
  ] as const)("maps the %s turn state to %s", (state, expected) => {
    const snapshots = build({
      threads: [shell({ latestTurn: { turnId: "turn-1", state } } as never)],
    });
    expect(snapshots[0]?.turnStatus).toBe(expected);
  });

  it("treats a thread that has never run as idle", () => {
    expect(build({ threads: [shell({ latestTurn: null })] })[0]?.turnStatus).toBe("idle");
  });

  it("carries the server's pending-approval and pending-input flags", () => {
    const snapshot = build({
      threads: [shell({ hasPendingApprovals: true, hasPendingUserInput: true })],
    })[0];
    expect(snapshot?.awaitingApproval).toBe(true);
    expect(snapshot?.awaitingUserInput).toBe(true);
  });

  it("leaves archived threads out", () => {
    expect(build({ threads: [shell({ archivedAt: "2026-01-01T00:00:00.000Z" })] })).toEqual([]);
  });

  it("has no summary for a thread whose detail is not loaded", () => {
    expect(build({ threads: [shell()] })[0]?.summary).toBeNull();
  });

  it("takes the summary from the last settled assistant message of the current turn", () => {
    const snapshots = build({
      threads: [shell()],
      details: new Map([
        [
          THREAD_ID as string,
          detail({
            messages: [
              { role: "assistant", text: "older", turnId: "turn-0", streaming: false },
              { role: "assistant", text: "done", turnId: "turn-1", streaming: false },
              { role: "user", text: "thanks", turnId: "turn-1", streaming: false },
            ],
          } as never),
        ],
      ]),
    });
    expect(snapshots[0]?.summary).toBe("done");
  });

  it("ignores a still-streaming assistant message", () => {
    const snapshots = build({
      threads: [shell()],
      details: new Map([
        [
          THREAD_ID as string,
          detail({
            messages: [{ role: "assistant", text: "half", turnId: "turn-1", streaming: true }],
          } as never),
        ],
      ]),
    });
    expect(snapshots[0]?.summary).toBeNull();
  });

  it("reports the most recent provider fallback", () => {
    const snapshots = build({
      threads: [shell()],
      details: new Map([
        [
          THREAD_ID as string,
          detail({
            activities: [
              { kind: FALLBACK_ENGAGED_ACTIVITY_KIND, createdAt: "2026-01-01T00:00:00.000Z" },
              { kind: "tool.completed", createdAt: "2026-01-01T00:01:00.000Z" },
              { kind: FALLBACK_ENGAGED_ACTIVITY_KIND, createdAt: "2026-01-01T00:02:00.000Z" },
            ],
          } as never),
        ],
      ]),
    });
    expect(snapshots[0]?.fallbackEngagedAt).toBe("2026-01-01T00:02:00.000Z");
  });
});
