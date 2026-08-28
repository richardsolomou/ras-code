import { describe, expect, it } from "vite-plus/test";

import {
  activeFallbackNotice,
  describeFallbackNotice,
  latestFallbackNotice,
  readFallbackNoticePayload,
  usageLimitPill,
} from "./providerUsageLimit.logic";

const at = (isoTime: string) => (isoTime === "2026-08-28T14:30:00.000Z" ? "14:30" : "??:??");

describe("usageLimitPill", () => {
  it("says nothing while quota is healthy", () => {
    expect(
      usageLimitPill({ status: "ok", resetsAt: null, kind: null, utilization: null }, at),
    ).toBe(null);
  });

  it("says nothing when the provider reported no usage-limit signal", () => {
    expect(usageLimitPill(null, at)).toBe(null);
  });

  it("names the reset time when the window is exhausted", () => {
    expect(
      usageLimitPill(
        {
          status: "exhausted",
          resetsAt: "2026-08-28T14:30:00.000Z",
          kind: "five_hour",
          utilization: 1,
        },
        at,
      ),
    ).toEqual({ kind: "exhausted", label: "Limit reached · resets 14:30" });
  });

  it("drops the reset time when the provider did not report one", () => {
    expect(
      usageLimitPill({ status: "exhausted", resetsAt: null, kind: null, utilization: null }, at),
    ).toEqual({ kind: "exhausted", label: "Limit reached" });
  });

  it("marks an approaching limit separately from an exhausted one", () => {
    expect(
      usageLimitPill({ status: "warning", resetsAt: null, kind: null, utilization: 0.9 }, at)?.kind,
    ).toBe("warning");
  });
});

describe("readFallbackNoticePayload", () => {
  it("reads a well-formed payload", () => {
    expect(
      readFallbackNoticePayload({
        primaryInstanceId: "claude_primary",
        fallbackInstanceId: "claude_posthog_gateway",
        model: "posthog/zai-org/glm-5.2",
        resetsAt: "2026-08-28T14:30:00.000Z",
      }),
    ).toEqual({
      primaryInstanceId: "claude_primary",
      fallbackInstanceId: "claude_posthog_gateway",
      model: "posthog/zai-org/glm-5.2",
      resetsAt: "2026-08-28T14:30:00.000Z",
    });
  });

  it("rejects a payload missing the fallback instance", () => {
    expect(readFallbackNoticePayload({ primaryInstanceId: "a", model: "m", resetsAt: null })).toBe(
      null,
    );
  });

  it("treats a non-string reset instant as absent", () => {
    expect(
      readFallbackNoticePayload({
        primaryInstanceId: "a",
        fallbackInstanceId: "b",
        model: "m",
        resetsAt: 17,
      })?.resetsAt,
    ).toBe(null);
  });
});

describe("latestFallbackNotice", () => {
  const notice = (model: string) => ({
    kind: "provider.fallback.engaged",
    payload: { primaryInstanceId: "a", fallbackInstanceId: "b", model, resetsAt: null },
  });

  it("takes the most recent notice", () => {
    expect(
      latestFallbackNotice([notice("old"), { kind: "tool.completed", payload: {} }, notice("new")])
        ?.model,
    ).toBe("new");
  });

  it("returns nothing for a thread that never fell back", () => {
    expect(latestFallbackNotice([{ kind: "tool.completed", payload: {} }])).toBe(null);
  });

  it("skips a notice whose payload cannot be read", () => {
    expect(
      latestFallbackNotice([notice("good"), { kind: "provider.fallback.engaged", payload: null }])
        ?.model,
    ).toBe("good");
  });
});

describe("activeFallbackNotice", () => {
  const payload = (resetsAt: string | null) => ({
    primaryInstanceId: "a",
    fallbackInstanceId: "b",
    model: "m",
    resetsAt,
  });
  const now = Date.parse("2026-08-28T14:00:00.000Z");

  it("shows the pill while the window is still open", () => {
    expect(activeFallbackNotice({ payload: payload("2026-08-28T14:30:00.000Z"), now })).not.toBe(
      null,
    );
  });

  it("hides the pill once the window has passed", () => {
    expect(activeFallbackNotice({ payload: payload("2026-08-28T13:30:00.000Z"), now })).toBe(null);
  });

  it("keeps the pill up when the provider never said when the window reopens", () => {
    expect(activeFallbackNotice({ payload: payload(null), now })).not.toBe(null);
  });
});

describe("describeFallbackNotice", () => {
  it("renders the reset time in the viewer's locale rather than the raw instant", () => {
    expect(
      describeFallbackNotice({
        payload: {
          primaryInstanceId: "claude_primary",
          fallbackInstanceId: "claude_posthog_gateway",
          model: "posthog/zai-org/glm-5.2",
          resetsAt: "2026-08-28T14:30:00.000Z",
        },
        primaryName: "Claude",
        fallbackName: "PostHog AI Gateway",
        formatTime: at,
      }),
    ).toBe(
      "Claude reached its usage limit. Using PostHog AI Gateway (posthog/zai-org/glm-5.2) until 14:30.",
    );
  });

  it("omits the reset clause when no reset instant was reported", () => {
    expect(
      describeFallbackNotice({
        payload: {
          primaryInstanceId: "a",
          fallbackInstanceId: "b",
          model: "m",
          resetsAt: null,
        },
        primaryName: "Primary",
        fallbackName: "Fallback",
        formatTime: at,
      }),
    ).toBe("Primary reached its usage limit. Using Fallback (m).");
  });
});
