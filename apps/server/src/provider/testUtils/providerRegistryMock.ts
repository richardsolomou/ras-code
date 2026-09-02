import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import type { ProviderInstanceId, ProviderUsageLimit, ServerProvider } from "@ras-code/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { effectiveUsageLimit } from "../providerUsageLimit.ts";

export const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
  // Mutated in place so a test can observe what the code under test recorded.
  usageLimits: Map<ProviderInstanceId, ProviderUsageLimit> = new Map(),
): ProviderRegistryShape => {
  const liveUsageLimits = usageLimits;
  return {
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    refreshInstance: () => Effect.succeed(providers),
    getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
      ),
    setProviderMaintenanceActionState: () => Effect.succeed(providers),
    setProviderUsageLimit: ({ instanceId, usageLimit }) =>
      Effect.sync(() => {
        if (usageLimit === null) {
          liveUsageLimits.delete(instanceId);
        } else {
          liveUsageLimits.set(instanceId, usageLimit);
        }
        return providers;
      }),
    getProviderUsageLimit: (instanceId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((nowMs) => effectiveUsageLimit(liveUsageLimits.get(instanceId), nowMs)),
      ),
    streamChanges: Stream.empty,
    refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  };
};

export const makeProviderRegistryLayer = (
  providers: ReadonlyArray<ServerProvider> = [],
  usageLimits: Map<ProviderInstanceId, ProviderUsageLimit> = new Map(),
) => Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers, usageLimits));
