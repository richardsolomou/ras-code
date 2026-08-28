/**
 * The `provider.fallback.engaged` thread activity: the marker a thread gets
 * when a turn ran on a configured fallback because the primary provider
 * instance was out of quota. Shared so web and mobile read the same opaque
 * activity payload the same way; each surface words its own sentence.
 */

export const FALLBACK_ENGAGED_ACTIVITY_KIND = "provider.fallback.engaged";

export interface FallbackNoticePayload {
  readonly primaryInstanceId: string;
  readonly fallbackInstanceId: string;
  readonly model: string;
  readonly resetsAt: string | null;
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
  if (
    typeof primaryInstanceId !== "string" ||
    typeof fallbackInstanceId !== "string" ||
    typeof model !== "string"
  ) {
    return null;
  }
  const resetsAt = record.resetsAt;
  return {
    primaryInstanceId,
    fallbackInstanceId,
    model,
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}
