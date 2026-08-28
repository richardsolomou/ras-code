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
