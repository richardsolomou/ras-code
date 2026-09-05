import type { ProviderUsageLimit } from "@t3tools/contracts";
import {
  FALLBACK_DECLINED_ACTIVITY_KIND,
  FALLBACK_ENGAGED_ACTIVITY_KIND,
  FALLBACK_OFFER_EXPIRED_ACTIVITY_KIND,
  FALLBACK_OFFERED_ACTIVITY_KIND,
  FALLBACK_RETURNED_ACTIVITY_KIND,
  derivePendingFallbackOfferActivities,
  readFallbackNoticePayload,
  readFallbackOfferRequestId,
  readPendingFallbackOfferPayload,
  type FallbackNoticePayload,
  type PendingFallbackOfferPayload,
} from "@t3tools/client-runtime/provider-fallback";

export {
  FALLBACK_DECLINED_ACTIVITY_KIND,
  FALLBACK_ENGAGED_ACTIVITY_KIND,
  FALLBACK_OFFER_EXPIRED_ACTIVITY_KIND,
  FALLBACK_OFFERED_ACTIVITY_KIND,
  FALLBACK_RETURNED_ACTIVITY_KIND,
  derivePendingFallbackOfferActivities,
  readFallbackNoticePayload,
  readFallbackOfferRequestId,
  readPendingFallbackOfferPayload,
  type FallbackNoticePayload,
  type PendingFallbackOfferPayload,
};

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
  const model = input.payload.modelLabel ?? input.payload.model;
  const head = `${input.primaryName} reached its usage limit. Continuing with ${model} via ${input.fallbackName}`;
  return resetsAt ? `${head} until ${resetsAt}.` : `${head}.`;
}

/**
 * The active fallback notice on a thread. A reset time only starts a return
 * attempt; the returned activity confirms that the subscription accepted it.
 */
export function latestFallbackNotice(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): FallbackNoticePayload | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind === FALLBACK_RETURNED_ACTIVITY_KIND) return null;
    if (activity?.kind !== FALLBACK_ENGAGED_ACTIVITY_KIND) continue;
    const payload = readFallbackNoticePayload(activity.payload);
    if (payload !== null) return payload;
  }
  return null;
}
