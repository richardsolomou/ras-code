import { describe, expect, it } from "vite-plus/test";

import {
  effectiveUsageLimit,
  exhaustedUsageLimitFromError,
  isUsageLimitFailureMessage,
  normalizeProviderUsageLimit,
  usageLimitResetFromMessage,
  USAGE_LIMIT_DEFAULT_COOLDOWN_MS,
} from "./providerUsageLimit.ts";

const RESETS_AT_SECONDS = 1_800_000_000;
const RESETS_AT_ISO = "2027-01-15T08:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_RESETS_AT_SECONDS = RESETS_AT_SECONDS + 4 * 24 * 60 * 60;
const WEEKLY_RESETS_AT_ISO = "2027-01-19T08:00:00.000Z";

describe("normalizeProviderUsageLimit", () => {
  it("reads a rejected Claude rate limit event as exhausted", () => {
    expect(
      normalizeProviderUsageLimit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: RESETS_AT_SECONDS,
          rateLimitType: "five_hour",
          utilization: 1,
        },
      }),
    ).toEqual({
      status: "exhausted",
      resetsAt: RESETS_AT_ISO,
      kind: "five_hour",
      utilization: 1,
      windows: [{ name: "five_hour", usedPercent: 100, resetsAt: RESETS_AT_ISO }],
    });
  });

  it("reads a Claude warning as warning rather than exhausted", () => {
    expect(
      normalizeProviderUsageLimit({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", utilization: 0.92 },
      })?.status,
    ).toBe("warning");
  });

  it("reads an allowed Claude event as ok", () => {
    expect(
      normalizeProviderUsageLimit({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      })?.status,
    ).toBe("ok");
  });

  it("reads a full Codex window as exhausted and reports its reset instant", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: RESETS_AT_SECONDS, windowDurationMins: 300 },
          secondary: { usedPercent: 40 },
        },
      }),
    ).toEqual({
      status: "exhausted",
      resetsAt: RESETS_AT_ISO,
      kind: "primary",
      utilization: 1,
      windows: [
        { name: "primary", usedPercent: 100, resetsAt: RESETS_AT_ISO },
        { name: "secondary", usedPercent: 40, resetsAt: null },
      ],
    });
  });

  it("waits for the weekly window when both Codex windows are full", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: RESETS_AT_SECONDS, windowDurationMins: 300 },
          secondary: {
            usedPercent: 100,
            resetsAt: WEEKLY_RESETS_AT_SECONDS,
            windowDurationMins: 10_080,
          },
          rateLimitReachedType: "primary",
        },
      })?.resetsAt,
    ).toBe(WEEKLY_RESETS_AT_ISO);
  });

  it("ignores a later reset on a window that still has quota", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: RESETS_AT_SECONDS, windowDurationMins: 300 },
          secondary: {
            usedPercent: 99,
            resetsAt: WEEKLY_RESETS_AT_SECONDS,
            windowDurationMins: 10_080,
          },
          rateLimitReachedType: "primary",
        },
      })?.resetsAt,
    ).toBe(RESETS_AT_ISO);
  });

  it("records every Codex window the provider reported", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: RESETS_AT_SECONDS, windowDurationMins: 300 },
          secondary: {
            usedPercent: 42,
            resetsAt: WEEKLY_RESETS_AT_SECONDS,
            windowDurationMins: 10_080,
          },
        },
      })?.windows,
    ).toEqual([
      { name: "primary", usedPercent: 100, resetsAt: RESETS_AT_ISO },
      { name: "secondary", usedPercent: 42, resetsAt: WEEKLY_RESETS_AT_ISO },
    ]);
  });

  it("records the Claude window under the name the provider gave it", () => {
    expect(
      normalizeProviderUsageLimit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: RESETS_AT_SECONDS,
          rateLimitType: "seven_day",
          utilization: 1,
        },
      })?.windows,
    ).toEqual([{ name: "seven_day", usedPercent: 100, resetsAt: RESETS_AT_ISO }]);
  });

  it("names no windows when the state came from a failure message", () => {
    expect(
      exhaustedUsageLimitFromError({ nowMs: Date.parse(RESETS_AT_ISO), message: "usage limit" })
        .windows,
    ).toBeUndefined();
  });

  it("reads a Codex rateLimitReachedType as exhausted even below 100 percent", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: {
          primary: { usedPercent: 10 },
          rateLimitReachedType: "workspace_owner_credits_depleted",
        },
      }),
    ).toEqual({
      status: "exhausted",
      resetsAt: null,
      kind: "workspace_owner_credits_depleted",
      utilization: 0.1,
      windows: [{ name: "primary", usedPercent: 10, resetsAt: null }],
    });
  });

  it("reads partially-used Codex windows as ok", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: { primary: { usedPercent: 12 }, secondary: { usedPercent: 55 } },
      }),
    ).toEqual({
      status: "ok",
      resetsAt: null,
      kind: "secondary",
      utilization: 0.55,
      windows: [
        { name: "primary", usedPercent: 12, resetsAt: null },
        { name: "secondary", usedPercent: 55, resetsAt: null },
      ],
    });
  });

  it("returns null for a payload it does not recognise", () => {
    expect(normalizeProviderUsageLimit({ somethingElse: true })).toBeNull();
  });
});

describe("effectiveUsageLimit", () => {
  const exhausted = {
    status: "exhausted",
    resetsAt: RESETS_AT_ISO,
    kind: "five_hour",
    utilization: 1,
  } as const;

  it("keeps an exhausted state while its reset instant is in the future", () => {
    expect(effectiveUsageLimit(exhausted, Date.parse(RESETS_AT_ISO) - 1)?.status).toBe("exhausted");
  });

  it("clears an exhausted state once its reset instant has passed", () => {
    expect(effectiveUsageLimit(exhausted, Date.parse(RESETS_AT_ISO) + 1)?.status).toBe("ok");
  });

  it("keeps an exhausted state with no reset instant", () => {
    expect(
      effectiveUsageLimit({ ...exhausted, resetsAt: null }, Date.parse(RESETS_AT_ISO))?.status,
    ).toBe("exhausted");
  });

  it("returns null when nothing has been recorded", () => {
    expect(effectiveUsageLimit(undefined, 0)).toBeNull();
  });
});

describe("usageLimitResetFromMessage", () => {
  /** Local, because a bare wall-clock string in the message carries no zone. */
  const codexReset = Date.parse("Sep 7, 2026 5:27 AM");
  const codexMessage =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 7th, 2026 5:27 AM";

  it("reads the reset instant out of Codex's prose", () => {
    expect(
      Date.parse(
        usageLimitResetFromMessage({ message: codexMessage, nowMs: codexReset - 5 * DAY_MS }) ?? "",
      ),
    ).toBe(codexReset);
  });

  it("reads the unix seconds Claude Code appends to its message", () => {
    const resetsAtMs = 1_800_000_000_000;
    expect(
      usageLimitResetFromMessage({
        message: `Claude AI usage limit reached|${resetsAtMs / 1000}`,
        nowMs: resetsAtMs - DAY_MS,
      }),
    ).toBe(RESETS_AT_ISO);
  });

  it("keeps a zoned instant in its own zone rather than reading it as local", () => {
    const resetsAt = "2027-01-15T08:00:00.597Z";
    expect(
      usageLimitResetFromMessage({
        message: `usage limit reached, try again at ${resetsAt}`,
        nowMs: Date.parse(resetsAt) - DAY_MS,
      }),
    ).toBe(resetsAt);
  });

  it("refuses a reset instant that has already passed", () => {
    expect(usageLimitResetFromMessage({ message: codexMessage, nowMs: codexReset + 1 })).toBeNull();
  });

  it("refuses a reset instant further out than any quota window", () => {
    expect(
      usageLimitResetFromMessage({ message: codexMessage, nowMs: codexReset - 15 * DAY_MS }),
    ).toBeNull();
  });

  it("finds nothing in a message that names no instant", () => {
    expect(
      usageLimitResetFromMessage({ message: "Claude AI usage limit reached", nowMs: 0 }),
    ).toBeNull();
  });
});

describe("exhaustedUsageLimitFromError", () => {
  it("parks the instance for the default cooldown", () => {
    const nowMs = Date.parse(RESETS_AT_ISO);
    const limit = exhaustedUsageLimitFromError({ nowMs });
    expect(Date.parse(limit.resetsAt ?? "")).toBe(nowMs + USAGE_LIMIT_DEFAULT_COOLDOWN_MS);
  });

  it("prefers the reset instant the failure message named", () => {
    const nowMs = Date.parse("2026-09-02T00:00:00.000Z");
    const limit = exhaustedUsageLimitFromError({
      nowMs,
      message: "usage limit reached, try again at 2026-09-07T05:27:00Z",
    });
    expect(limit.resetsAt).toBe("2026-09-07T05:27:00.000Z");
  });
});

describe("isUsageLimitFailureMessage", () => {
  it("recognises Claude's usage limit prose", () => {
    expect(isUsageLimitFailureMessage("Claude AI usage limit reached|1800000000")).toBe(true);
  });

  it("recognises an HTTP 429 failure", () => {
    expect(isUsageLimitFailureMessage("API Error: 429 Too Many Requests")).toBe(true);
  });

  it("does not treat an unrelated failure as a usage limit", () => {
    expect(isUsageLimitFailureMessage("Tool execution failed: file not found")).toBe(false);
  });

  it("does not treat a missing message as a usage limit", () => {
    expect(isUsageLimitFailureMessage(undefined)).toBe(false);
  });
});
