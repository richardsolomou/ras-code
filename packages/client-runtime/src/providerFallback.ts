/**
 * The `provider.fallback.engaged` thread activity: the marker a thread gets
 * when a turn ran through the PostHog AI Gateway because the primary provider
 * instance was out of quota. Shared so web and mobile read the same opaque
 * activity payload the same way; each surface words its own sentence.
 */

export const FALLBACK_ENGAGED_ACTIVITY_KIND = "provider.fallback.engaged";
export const FALLBACK_OFFERED_ACTIVITY_KIND = "provider.fallback.offered";
export const FALLBACK_DECLINED_ACTIVITY_KIND = "provider.fallback.declined";
export const FALLBACK_OFFER_EXPIRED_ACTIVITY_KIND = "provider.fallback.offer-expired";
export const FALLBACK_RETURNED_ACTIVITY_KIND = "provider.fallback.returned";

export interface FallbackNoticePayload {
  readonly primaryInstanceId: string;
  readonly fallbackInstanceId: string;
  readonly model: string;
  readonly modelLabel?: string;
  readonly resetsAt: string | null;
  /** Present when this engagement resolved a `provider.fallback.offered` prompt. */
  readonly requestId?: string;
}

/**
 * Read the typed payload off a `provider.fallback.engaged` activity.
 * Activities carry an opaque payload, so anything malformed is treated as
 * "no notice" rather than rendered half-filled.
 */
export function readFallbackNoticePayload(payload: unknown): FallbackNoticePayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const primaryInstanceId = record.primaryInstanceId;
  const fallbackInstanceId = record.fallbackInstanceId;
  const model = record.model;
  const modelLabel = record.modelLabel;
  if (
    typeof primaryInstanceId !== "string" ||
    typeof fallbackInstanceId !== "string" ||
    typeof model !== "string"
  ) {
    return null;
  }
  const resetsAt = record.resetsAt;
  const requestId = record.requestId;
  return {
    primaryInstanceId,
    fallbackInstanceId,
    model,
    ...(typeof modelLabel === "string" ? { modelLabel } : {}),
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

export interface PendingFallbackOfferPayload {
  readonly requestId: string;
  readonly primaryInstanceId: string;
  readonly fallbackInstanceId: string;
  readonly model: string;
  readonly modelLabel?: string;
  readonly resetsAt: string | null;
}

/**
 * Read the typed payload off a `provider.fallback.offered` activity: the
 * still-open "switch or wait?" prompt for a usage-limit failure.
 */
export function readPendingFallbackOfferPayload(
  payload: unknown,
): PendingFallbackOfferPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const requestId = record.requestId;
  const primaryInstanceId = record.primaryInstanceId;
  const fallbackInstanceId = record.fallbackInstanceId;
  const model = record.model;
  const modelLabel = record.modelLabel;
  if (
    typeof requestId !== "string" ||
    typeof primaryInstanceId !== "string" ||
    typeof fallbackInstanceId !== "string" ||
    typeof model !== "string"
  ) {
    return null;
  }
  const resetsAt = record.resetsAt;
  return {
    requestId,
    primaryInstanceId,
    fallbackInstanceId,
    model,
    ...(typeof modelLabel === "string" ? { modelLabel } : {}),
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}

/** Read the `requestId` off a `provider.fallback.declined` or `.offer-expired` activity. */
export function readFallbackOfferRequestId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}
