import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

/**
 * The `provider.fallback.engaged` thread activity: the marker a thread gets
 * when a turn ran on another provider instance because the primary one was
 * out of quota. Shared so web and mobile read the opaque activity payload the
 * same way. Each surface writes its own sentence.
 */

export const FALLBACK_ENGAGED_ACTIVITY_KIND = "provider.fallback.engaged";
export const FALLBACK_OFFERED_ACTIVITY_KIND = "provider.fallback.offered";
export const FALLBACK_DECLINED_ACTIVITY_KIND = "provider.fallback.declined";
export const FALLBACK_OFFER_EXPIRED_ACTIVITY_KIND = "provider.fallback.offer-expired";
export const FALLBACK_RETURNED_ACTIVITY_KIND = "provider.fallback.returned";

const POSTHOG_GATEWAY_DRIVER = "posthogGateway";

type FallbackProviderSnapshot = Pick<ServerProvider, "instanceId" | "driver" | "displayName">;

function findFallbackProvider(
  providers: Iterable<FallbackProviderSnapshot>,
  instanceId: string,
): FallbackProviderSnapshot | undefined {
  for (const provider of providers) {
    if (String(provider.instanceId) === instanceId) return provider;
  }
  return undefined;
}

/**
 * Name a provider instance in a fallback notice: the user's display name,
 * else the driver's name, else the instance id.
 */
export function fallbackInstanceLabel(
  providers: Iterable<FallbackProviderSnapshot>,
  instanceId: string,
): string {
  const provider = findFallbackProvider(providers, instanceId);
  return (
    provider?.displayName?.trim() ||
    (provider ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ||
    instanceId
  );
}

/**
 * Whether crossing to this instance costs money per turn. The gateway bills
 * usage; a subscription is already paid for.
 */
export function fallbackInstanceIsMetered(
  providers: Iterable<FallbackProviderSnapshot>,
  instanceId: string,
): boolean {
  return findFallbackProvider(providers, instanceId)?.driver === POSTHOG_GATEWAY_DRIVER;
}

export function resolveActiveProviderInstanceId(thread: {
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly session: {
    readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  } | null;
}): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

export function resolveActiveProviderModelSelection(
  thread: {
    readonly modelSelection: ModelSelection;
    readonly session: {
      readonly providerInstanceId?: ProviderInstanceId | null | undefined;
    } | null;
  },
  providers: Iterable<{
    readonly instanceId: ProviderInstanceId;
    readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug">>;
  }>,
): ModelSelection {
  const instanceId = resolveActiveProviderInstanceId(thread);
  if (instanceId === thread.modelSelection.instanceId) return thread.modelSelection;
  let models: ReadonlyArray<Pick<ServerProviderModel, "slug">> = [];
  for (const provider of providers) {
    if (provider.instanceId === instanceId) {
      models = provider.models;
      break;
    }
  }
  const selectedModel =
    models.find((model) => model.slug === thread.modelSelection.model) ??
    models.find(
      (model) =>
        model.slug.slice(model.slug.lastIndexOf("/") + 1) ===
        thread.modelSelection.model.slice(thread.modelSelection.model.lastIndexOf("/") + 1),
    );
  return {
    ...thread.modelSelection,
    instanceId,
    ...(selectedModel ? { model: selectedModel.slug } : {}),
  };
}

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
  /**
   * The fallback cannot resume this thread's provider conversation, so
   * accepting restarts it there with the transcript replayed as context.
   */
  readonly restartsSession: boolean;
}

export interface PendingFallbackOfferActivity extends PendingFallbackOfferPayload {
  readonly createdAt: string;
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
    restartsSession: record.restartsSession === true,
  };
}

export function derivePendingFallbackOfferActivities(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>,
): ReadonlyArray<PendingFallbackOfferActivity> {
  const settledRequestIds = new Set<string>();
  const openByRequestId = new Map<string, PendingFallbackOfferActivity>();

  for (const activity of activities) {
    if (
      activity.kind === FALLBACK_ENGAGED_ACTIVITY_KIND ||
      activity.kind === FALLBACK_DECLINED_ACTIVITY_KIND ||
      activity.kind === FALLBACK_OFFER_EXPIRED_ACTIVITY_KIND
    ) {
      const requestId = readFallbackOfferRequestId(activity.payload);
      if (requestId !== null) {
        settledRequestIds.add(requestId);
        openByRequestId.delete(requestId);
      }
      continue;
    }

    if (activity.kind !== FALLBACK_OFFERED_ACTIVITY_KIND) continue;
    const offer = readPendingFallbackOfferPayload(activity.payload);
    if (offer === null || settledRequestIds.has(offer.requestId)) continue;
    openByRequestId.set(offer.requestId, { ...offer, createdAt: activity.createdAt });
  }

  return [...openByRequestId.values()];
}

/** Read the `requestId` off a `provider.fallback.declined` or `.offer-expired` activity. */
export function readFallbackOfferRequestId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}
