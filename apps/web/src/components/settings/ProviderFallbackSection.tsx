"use client";

import {
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@ras-code/contracts";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  fallbackModelMode,
  instanceWithFallback,
  selectableFallbackInstances,
} from "./providerFallback.logic";

const NO_FALLBACK_VALUE = "none";
const SAME_MODEL_VALUE = "same";

interface ProviderFallbackSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly instances: ProviderInstanceConfigMap;
  /** Live snapshots, used to offer the fallback instance's models. */
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}

/**
 * Binds one provider instance to the instance that takes over when its
 * usage limit is exhausted. Model selection defaults to "same model",
 * which is right whenever the fallback proxies the same catalog.
 */
export function ProviderFallbackSection({
  instanceId,
  instance,
  instances,
  serverProviders,
  onUpdate,
}: ProviderFallbackSectionProps) {
  const candidates = selectableFallbackInstances({ instanceId, instances });
  const fallback = instance.fallback ?? null;
  const modelMode = fallbackModelMode(instance);
  const fallbackProvider = fallback
    ? serverProviders.find((provider) => provider.instanceId === fallback.instanceId)
    : undefined;
  const fallbackModels = fallbackProvider?.models ?? [];
  const bothClaude =
    fallback !== null &&
    String(instance.driver) === "claudeAgent" &&
    String(instances[fallback.instanceId]?.driver ?? "") === "claudeAgent";

  const selectFallbackInstance = (value: string | null) => {
    if (value === null || value === NO_FALLBACK_VALUE) {
      onUpdate(instanceWithFallback(instance, null));
      return;
    }
    onUpdate(instanceWithFallback(instance, { instanceId: ProviderInstanceId.make(value) }));
  };

  const selectFallbackModel = (value: string | null) => {
    if (fallback === null) return;
    onUpdate(
      instanceWithFallback(instance, {
        instanceId: fallback.instanceId,
        model: value === null || value === SAME_MODEL_VALUE ? null : value,
      }),
    );
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Fallback</span>
        {fallback ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => selectFallbackInstance(null)}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add a second enabled provider instance to use one as a fallback.
        </p>
      ) : (
        <>
          <label className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">
              When this provider's usage limit is reached, use:
            </span>
            <Select
              value={fallback ? String(fallback.instanceId) : NO_FALLBACK_VALUE}
              onValueChange={selectFallbackInstance}
            >
              <SelectTrigger size="sm" aria-label="Fallback provider instance">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_FALLBACK_VALUE}>No fallback</SelectItem>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.instanceId} value={String(candidate.instanceId)}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>

          {fallback ? (
            <label className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">Model on the fallback</span>
              <Select
                value={
                  modelMode === "specific" ? (fallback.model ?? SAME_MODEL_VALUE) : SAME_MODEL_VALUE
                }
                onValueChange={selectFallbackModel}
              >
                <SelectTrigger size="sm" aria-label="Fallback model">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={SAME_MODEL_VALUE}>Same model</SelectItem>
                  {fallbackModels.map((model) => (
                    <SelectItem key={model.slug} value={model.slug}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          ) : null}

          <span className="text-xs text-muted-foreground">
            {bothClaude
              ? "Two Claude instances with different CLAUDE_CONFIG_DIR paths are separate Claude environments, so the fallback applies to new threads only. Leave the fallback's config directory empty to share this one and keep existing threads working."
              : "Fallbacks are never chained: one hop only."}
          </span>
        </>
      )}
    </div>
  );
}
