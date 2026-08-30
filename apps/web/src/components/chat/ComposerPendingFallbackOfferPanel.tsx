import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ras-code/contracts";
import { memo } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import type { PendingFallbackOffer } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingFallbackOfferPanelProps {
  offer: PendingFallbackOffer;
  providers: ReadonlyArray<ServerProvider>;
  className?: string;
}

export const ComposerPendingFallbackOfferPanel = memo(function ComposerPendingFallbackOfferPanel({
  offer,
  providers,
  className,
}: ComposerPendingFallbackOfferPanelProps) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const instanceName = (instanceId: string) => {
    const provider = providers.find((entry) => String(entry.instanceId) === instanceId);
    return (
      provider?.displayName?.trim() ||
      (provider ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ||
      instanceId
    );
  };
  const primaryName = instanceName(offer.primaryInstanceId);
  const fallbackName = instanceName(offer.fallbackInstanceId);
  const resetsAt = offer.resetsAt ? formatShortTimestamp(offer.resetsAt, timestampFormat) : null;

  return (
    <div
      aria-label="Usage limit fallback offer"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      role="group"
    >
      <span className="truncate text-sm font-medium text-foreground">
        {primaryName} hit its usage limit
      </span>
      <span className="text-sm text-foreground/85">
        Continue with {offer.modelLabel ?? offer.model} via {fallbackName} using usage-based tokens
        {resetsAt ? `, or wait until ${resetsAt}` : ""}?
      </span>
    </div>
  );
});
