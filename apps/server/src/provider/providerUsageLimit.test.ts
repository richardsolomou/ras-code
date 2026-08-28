import { describe, expect, it } from "vite-plus/test";

import {
  effectiveUsageLimit,
  exhaustedUsageLimitFromError,
  isUsageLimitFailureMessage,
  normalizeProviderUsageLimit,
  USAGE_LIMIT_DEFAULT_COOLDOWN_MS,
} from "./providerUsageLimit.ts";

const RESETS_AT_SECONDS = 1_800_000_000;
const RESETS_AT_ISO = "2027-01-15T08:00:00.000Z";

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
    });
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
    });
  });

  it("reads partially-used Codex windows as ok", () => {
    expect(
      normalizeProviderUsageLimit({
        rateLimits: { primary: { usedPercent: 12 }, secondary: { usedPercent: 55 } },
      }),
    ).toEqual({ status: "ok", resetsAt: null, kind: "secondary", utilization: 0.55 });
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

describe("exhaustedUsageLimitFromError", () => {
  it("parks the instance for the default cooldown", () => {
    const nowMs = Date.parse(RESETS_AT_ISO);
    const limit = exhaustedUsageLimitFromError({ nowMs });
    expect(Date.parse(limit.resetsAt ?? "")).toBe(nowMs + USAGE_LIMIT_DEFAULT_COOLDOWN_MS);
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
