import {
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
} from "@ras-code/contracts";

export interface FallbackCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

/**
 * Instances that may be named as `instanceId`'s fallback.
 *
 * Excludes the instance itself, instances the user has disabled, and any
 * instance that already falls back to this one — the server follows at most
 * one hop, so a two-instance cycle would silently strand the second turn.
 */
export function selectableFallbackInstances(input: {
  readonly instanceId: ProviderInstanceId;
  readonly instances: ProviderInstanceConfigMap;
}): ReadonlyArray<FallbackCandidate> {
  return Object.entries(input.instances)
    .filter(([candidateId, candidate]) => {
      if (candidateId === String(input.instanceId)) return false;
      if (!resolveProviderInstanceEnabled(candidate)) return false;
      return candidate.fallback?.instanceId !== input.instanceId;
    })
    .map(([candidateId, candidate]) => ({
      instanceId: candidateId as ProviderInstanceId,
      displayName: candidate.displayName?.trim() || candidateId,
    }));
}

export type FallbackModelMode = "same" | "specific";

export function fallbackModelMode(instance: ProviderInstanceConfig): FallbackModelMode {
  return instance.fallback?.model ? "specific" : "same";
}

export type FallbackDriverRelation = "none" | "same-driver" | "cross-driver";

export const CROSS_DRIVER_FALLBACK_HELPER_TEXT =
  "Applies to new threads only (different providers cannot continue a conversation).";

/**
 * Continuation group key per instance, read from the live snapshots. Two
 * instances that share one can hand a started thread between them whatever
 * drivers they run on.
 */
export type ContinuationKeys = Readonly<Record<string, string | undefined>>;

/**
 * Whether the bound fallback can continue this instance's conversations.
 *
 * The server decides this on the continuation key, so the UI does too when
 * the snapshots carry one: a composite driver adopts the key of the harness
 * it wraps precisely so it can stand in for it. Without keys — an instance
 * the server has not reported yet — the driver kind is the best guess.
 * `cross-driver` means a different catalog: it can only pick up a thread that
 * has not started, and "same model" means nothing across the boundary.
 */
export function fallbackDriverRelation(
  instance: ProviderInstanceConfig,
  instances: ProviderInstanceConfigMap,
  continuationKeys?: ContinuationKeys,
  instanceId?: ProviderInstanceId,
): FallbackDriverRelation {
  const fallbackId = instance.fallback?.instanceId;
  if (fallbackId === undefined) return "none";
  const target = instances[fallbackId];
  if (target === undefined) return "none";
  const ownKey = instanceId === undefined ? undefined : continuationKeys?.[String(instanceId)];
  const fallbackKey = continuationKeys?.[String(fallbackId)];
  if (ownKey !== undefined && fallbackKey !== undefined) {
    return ownKey === fallbackKey ? "same-driver" : "cross-driver";
  }
  return String(target.driver) === String(instance.driver) ? "same-driver" : "cross-driver";
}

/**
 * True when the binding must name a model before it can do anything. The
 * server drops a cross-driver fallback that carries no model, so the UI has
 * to ask for one rather than let the user save a binding that never fires.
 */
export function fallbackNeedsExplicitModel(
  instance: ProviderInstanceConfig,
  instances: ProviderInstanceConfigMap,
  continuationKeys?: ContinuationKeys,
  instanceId?: ProviderInstanceId,
): boolean {
  const fallbackId = instance.fallback?.instanceId;
  // The gateway serves both model shapes, so the primary's own model is valid
  // there whatever driver the primary runs on.
  if (fallbackId !== undefined && String(instances[fallbackId]?.driver) === "posthogGateway") {
    return false;
  }
  return (
    fallbackDriverRelation(instance, instances, continuationKeys, instanceId) === "cross-driver" &&
    !instance.fallback?.model
  );
}

/**
 * Write the fallback binding. `null` clears it; the contract treats an
 * explicit `null` in a patch as "remove", so the key stays present.
 */
export function instanceWithFallback(
  instance: ProviderInstanceConfig,
  fallback: { readonly instanceId: ProviderInstanceId; readonly model?: string | null } | null,
): ProviderInstanceConfig {
  if (fallback === null) {
    return { ...instance, fallback: null };
  }
  const model = fallback.model?.trim();
  return {
    ...instance,
    fallback: {
      instanceId: fallback.instanceId,
      ...(model ? { model } : {}),
    },
  };
}
