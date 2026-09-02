/**
 * Usage-limit normalisation.
 *
 * Providers report quota state in incompatible shapes. Both adapters forward
 * the native payload verbatim on `account.rate-limits.updated`, so the
 * normalisation lives here rather than in either adapter:
 *
 *   - Claude forwards the Agent SDK's `SDKRateLimitEvent`:
 *     `{ type: "rate_limit_event", rate_limit_info: { status, resetsAt?,
 *     rateLimitType?, utilization? } }`, where `resetsAt` is unix seconds.
 *   - Codex forwards the app-server's `account/rateLimits/updated` params,
 *     which nest one more level: `{ rateLimits: { primary?, secondary?,
 *     rateLimitReachedType?, ... } }`, where each window carries
 *     `usedPercent` (0..100) and `resetsAt` in unix seconds.
 *
 * Unknown shapes normalise to `null` — an unrecognised payload must never be
 * read as "exhausted", because that would strand a working instance.
 *
 * @module providerUsageLimit
 */
import { IsoDateTime, type ProviderUsageLimit } from "@ras-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";

/**
 * Cooldown applied when a provider says it is out of quota without saying
 * when the window reopens. Long enough to stop hammering the exhausted
 * instance, short enough that a wrongly-inferred exhaustion self-heals.
 */
export const USAGE_LIMIT_DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

const CODEX_EXHAUSTED_PERCENT = 100;

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Unix seconds (what both providers emit) to an ISO instant. */
const isoFromUnixSeconds = (value: unknown): string | null => {
  if (!Predicate.isNumber(value) || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
};

const trimmedOrNull = (value: unknown): string | null => {
  if (!Predicate.isString(value)) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const percentFromFraction = (value: number | null): number | null =>
  value === null ? null : value * 100;

const clampUtilization = (value: unknown, scale: number): number | null => {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value / scale));
};

const normalizeClaude = (payload: Record<string, unknown>): ProviderUsageLimit | null => {
  const info = readRecord(payload.rate_limit_info);
  if (!info) {
    return null;
  }
  const rawStatus = trimmedOrNull(info.status);
  const status: ProviderUsageLimit["status"] =
    rawStatus === "rejected" ? "exhausted" : rawStatus === "allowed_warning" ? "warning" : "ok";
  const kind = trimmedOrNull(info.rateLimitType);
  // The SDK reports utilization as a 0..1 fraction.
  const utilization = clampUtilization(info.utilization, 1);
  const resetsAt = isoFromUnixSeconds(info.resetsAt);
  return {
    status,
    resetsAt,
    kind,
    utilization,
    // Claude reports one window at a time, so the summary already describes
    // it. Recorded anyway to keep the field's meaning uniform per provider.
    windows: [{ name: kind ?? "window", usedPercent: percentFromFraction(utilization), resetsAt }],
  };
};

/**
 * Pick the window that best describes the account's state: the one that is
 * exhausted, else the most-consumed one. Codex reports several rolling
 * windows and a turn is blocked as soon as any of them is full.
 *
 * Because any full window blocks a turn, quota returns only once the last
 * full window has reset. Reporting the most-consumed window's reset instead
 * would send the thread back to a subscription that is still out of quota:
 * a full five-hour window resets long before a full weekly one.
 */
const normalizeCodex = (payload: Record<string, unknown>): ProviderUsageLimit | null => {
  // The Codex adapter forwards the whole notification, which wraps the
  // snapshot in a second `rateLimits` key.
  const snapshot = readRecord(payload.rateLimits) ?? payload;
  const windows: Array<{ readonly name: string; readonly window: Record<string, unknown> }> = [];
  for (const name of ["primary", "secondary"] as const) {
    const window = readRecord(snapshot[name]);
    if (window !== undefined) {
      windows.push({ name, window });
    }
  }
  const reachedType = trimmedOrNull(snapshot.rateLimitReachedType);
  let worst: { readonly name: string; readonly window: Record<string, unknown> } | undefined;
  let usedPercent: number | null = null;
  for (const candidate of windows) {
    const percent = Predicate.isNumber(candidate.window.usedPercent)
      ? candidate.window.usedPercent
      : null;
    if (
      worst === undefined ||
      (percent !== null && (usedPercent === null || percent > usedPercent))
    ) {
      worst = candidate;
      usedPercent = percent;
    }
  }
  if (worst === undefined) {
    if (reachedType === null) {
      return null;
    }
    return { status: "exhausted", resetsAt: null, kind: reachedType, utilization: null };
  }
  const lastExhaustedReset = windows.reduce<number | null>((latest, candidate) => {
    const percent = candidate.window.usedPercent;
    if (!Predicate.isNumber(percent) || percent < CODEX_EXHAUSTED_PERCENT) {
      return latest;
    }
    const reset = candidate.window.resetsAt;
    if (!Predicate.isNumber(reset)) {
      return latest;
    }
    return latest === null || reset > latest ? reset : latest;
  }, null);
  const status: ProviderUsageLimit["status"] =
    reachedType !== null || (usedPercent !== null && usedPercent >= CODEX_EXHAUSTED_PERCENT)
      ? "exhausted"
      : usedPercent !== null && usedPercent >= 90
        ? "warning"
        : "ok";
  return {
    status,
    resetsAt: isoFromUnixSeconds(lastExhaustedReset) ?? isoFromUnixSeconds(worst.window.resetsAt),
    kind: reachedType ?? worst.name,
    utilization: clampUtilization(usedPercent, 100),
    windows: windows.map((candidate) => ({
      name: candidate.name,
      usedPercent: Predicate.isNumber(candidate.window.usedPercent)
        ? candidate.window.usedPercent
        : null,
      resetsAt: isoFromUnixSeconds(candidate.window.resetsAt),
    })),
  };
};

/**
 * Normalise an `account.rate-limits.updated` payload. Returns `null` when the
 * payload carries nothing this build understands.
 */
export const normalizeProviderUsageLimit = (rateLimits: unknown): ProviderUsageLimit | null => {
  const payload = readRecord(rateLimits);
  if (!payload) {
    return null;
  }
  if (payload.rate_limit_info !== undefined) {
    return normalizeClaude(payload);
  }
  if (payload.rateLimits !== undefined || payload.primary !== undefined) {
    return normalizeCodex(payload);
  }
  return null;
};

/**
 * Furthest reset instant a failure message is allowed to claim. Quota windows
 * are hourly, five-hourly, or weekly, so anything beyond this is a misparse,
 * and honouring it would park a working instance for days.
 */
const USAGE_LIMIT_MAX_RESET_MS = 14 * 24 * 60 * 60 * 1000;

/** `Sep 7th, 2026 5:27 AM`, optionally zoned. Codex's wording. */
const MONTH_NAME_INSTANT =
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?(?:\s*(?:UTC|GMT|Z|[+-]\d{2}:?\d{2}))?)/;

/** Fractional seconds are part of the match: cutting them strips the zone that follows, and an
 * unzoned ISO string reads as local time. */
const ISO_INSTANT =
  /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** Claude Code appends the reset as `|<unix seconds>`. */
const PIPED_UNIX_SECONDS = /\|\s*(\d{10})(?!\d)/;

const ORDINAL_DAY = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;

/**
 * Read the reset instant a provider named in its usage-limit failure text.
 *
 * Worth the parsing: a subscription whose window reopens in five days
 * otherwise carries only the blind cooldown, so every thread re-probes it
 * every half hour. A bare wall-clock string carries no zone, which is right
 * to read as local — the harness formatted it on this machine.
 *
 * Refuses anything that does not parse, already passed, or lands beyond
 * `USAGE_LIMIT_MAX_RESET_MS`, so a stray date cannot strand an instance.
 */
export const usageLimitResetFromMessage = (input: {
  readonly message: string | undefined | null;
  readonly nowMs: number;
}): string | null => {
  if (!input.message) {
    return null;
  }
  const unixSeconds = PIPED_UNIX_SECONDS.exec(input.message)?.[1];
  const candidates = [
    unixSeconds === undefined ? Number.NaN : Number(unixSeconds) * 1000,
    ...[ISO_INSTANT, MONTH_NAME_INSTANT].map((pattern) => {
      const text = pattern.exec(input.message ?? "")?.[1];
      return text === undefined ? Number.NaN : Date.parse(text.replace(ORDINAL_DAY, "$1"));
    }),
  ];
  for (const resetsAtMs of candidates) {
    if (
      !Number.isNaN(resetsAtMs) &&
      resetsAtMs > input.nowMs &&
      resetsAtMs - input.nowMs <= USAGE_LIMIT_MAX_RESET_MS
    ) {
      return DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs));
    }
  }
  return null;
};

/**
 * Build the state recorded when a turn fails with a usage-limit error. The
 * message's own reset instant is used when it carries one; the cooldown is
 * the fallback for a provider that only says "later".
 */
export const exhaustedUsageLimitFromError = (input: {
  readonly nowMs: number;
  readonly kind?: string | undefined;
  readonly message?: string | undefined;
}): ProviderUsageLimit => ({
  status: "exhausted",
  resetsAt: IsoDateTime.make(
    usageLimitResetFromMessage({ message: input.message, nowMs: input.nowMs }) ??
      DateTime.formatIso(DateTime.makeUnsafe(input.nowMs + USAGE_LIMIT_DEFAULT_COOLDOWN_MS)),
  ),
  kind: input.kind ?? null,
  utilization: null,
});

/**
 * Apply the expiry rule: an exhausted state stops applying once `resetsAt`
 * has passed. Callers get `null` back when the recorded state no longer says
 * anything, so a stale entry never keeps an instance parked.
 */
export const effectiveUsageLimit = (
  usageLimit: ProviderUsageLimit | null | undefined,
  nowMs: number,
): ProviderUsageLimit | null => {
  if (!usageLimit) {
    return null;
  }
  if (usageLimit.status !== "exhausted" || usageLimit.resetsAt === null) {
    return usageLimit;
  }
  const resetsAtMs = Date.parse(usageLimit.resetsAt);
  if (Number.isNaN(resetsAtMs) || resetsAtMs > nowMs) {
    return usageLimit;
  }
  return { status: "ok", resetsAt: null, kind: usageLimit.kind, utilization: null };
};

const USAGE_LIMIT_ERROR_PATTERNS = [
  "usage limit",
  "rate limit",
  "rate_limit",
  "rate_limit_error",
  "429",
  "quota exceeded",
  "too many requests",
];

/**
 * Recognise a provider turn failure as quota exhaustion.
 *
 * The Claude adapter surfaces the SDK's `result` errors verbatim (see
 * `resultUserFacingError`), so there is no structured code to branch on —
 * matching the message is the only signal available. Kept deliberately narrow:
 * a false positive parks a healthy instance for the cooldown window.
 */
export const isUsageLimitFailureMessage = (message: string | undefined | null): boolean => {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return USAGE_LIMIT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
};

/** Items that carry no user-visible work of their own, so a retry repeats nothing. */
export const PASSIVE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "error",
  "unknown",
]);

/**
 * Whether streamed assistant text is real output rather than the provider
 * echoing its own failure (Claude surfaces API errors as assistant text).
 */
export function hasMeaningfulAssistantText(
  assistantText: string,
  errorMessage: string | undefined,
): boolean {
  const text = assistantText.trim();
  if (text.length === 0) return false;
  if (/^API Error\b/i.test(text)) return false;
  const error = errorMessage?.trim() ?? "";
  return error.length === 0 || !error.includes(text);
}
