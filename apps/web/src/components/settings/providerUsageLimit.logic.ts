import type { ProviderUsageLimit } from "@ras-code/contracts";
import {
  FALLBACK_ENGAGED_ACTIVITY_KIND,
  readFallbackNoticePayload,
  type FallbackNoticePayload,
} from "@ras-code/client-runtime/provider-fallback";

export { FALLBACK_ENGAGED_ACTIVITY_KIND, readFallbackNoticePayload, type FallbackNoticePayload };

/**
 * Renders an ISO instant as local wall-clock time. Injected rather than
 * imported so these functions stay pure and the caller keeps control of the
 * user's timestamp-format setting.
 */
export type TimeFormatter = (isoTime: string) => string;

function formatResetTime(isoTime: string | null | undefined, format: TimeFormatter): string | null {
  if (!isoTime) return null;
  const formatted = format(isoTime).trim();
  return formatted.length > 0 ? formatted : null;
}

export type UsageLimitPill =
  | { readonly kind: "exhausted"; readonly label: string }
  | { readonly kind: "warning"; readonly label: string }
  | null;

/**
 * Presentation for a provider's usage-limit state. `ok`, absent, and `null`
 * all mean "nothing to show" — the pill exists to explain why turns are
 * being routed elsewhere, not to narrate healthy quota.
 */
export function usageLimitPill(
  usageLimit: ProviderUsageLimit | null | undefined,
  formatTime: TimeFormatter,
): UsageLimitPill {
  if (!usageLimit || usageLimit.status === "ok") return null;
  const resetsAt = formatResetTime(usageLimit.resetsAt, formatTime);
  if (usageLimit.status === "exhausted") {
    return {
      kind: "exhausted",
      label: resetsAt ? `Limit reached · resets ${resetsAt}` : "Limit reached",
    };
  }
  return {
    kind: "warning",
    label: resetsAt ? `Approaching usage limit · resets ${resetsAt}` : "Approaching usage limit",
  };
}

/**
 * Sentence rendered on the timeline row, built from the payload so the time
 * reads in the viewer's locale rather than as the raw instant the server
 * put in `summary`.
 */
export function describeFallbackNotice(input: {
  readonly payload: FallbackNoticePayload;
  readonly primaryName: string;
  readonly fallbackName: string;
  readonly formatTime: TimeFormatter;
}): string {
  const resetsAt = formatResetTime(input.payload.resetsAt, input.formatTime);
  const head = `${input.primaryName} reached its usage limit. Using ${input.fallbackName} (${input.payload.model})`;
  return resetsAt ? `${head} until ${resetsAt}.` : `${head}.`;
}

/**
 * The fallback pill the composer shows, or `null` when the window that
 * triggered it has passed. A notice without a reset instant stays up: the
 * server applied its own cooldown and did not tell us when it ends, and a
 * quiet pill is better than pretending the primary is back.
 */
export function activeFallbackNotice(input: {
  readonly payload: FallbackNoticePayload | null;
  readonly now: number;
}): FallbackNoticePayload | null {
  if (input.payload === null) return null;
  if (input.payload.resetsAt === null) return input.payload;
  const resetsAt = new Date(input.payload.resetsAt).getTime();
  if (Number.isNaN(resetsAt)) return input.payload;
  return resetsAt > input.now ? input.payload : null;
}

/**
 * The most recent fallback notice on a thread, or `null` when the thread
 * has none. Activities arrive oldest-first, so the last match wins.
 */
export function latestFallbackNotice(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): FallbackNoticePayload | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== FALLBACK_ENGAGED_ACTIVITY_KIND) continue;
    const payload = readFallbackNoticePayload(activity.payload);
    if (payload !== null) return payload;
  }
  return null;
}
