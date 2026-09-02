import { type ServerProvider } from "@ras-code/contracts";
import {
  fallbackInstanceIsMetered,
  fallbackInstanceLabel,
} from "@ras-code/client-runtime/provider-fallback";
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
  const primaryName = fallbackInstanceLabel(providers, offer.primaryInstanceId);
  const fallbackName = fallbackInstanceLabel(providers, offer.fallbackInstanceId);
  const metered = fallbackInstanceIsMetered(providers, offer.fallbackInstanceId);
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
        Continue with {offer.modelLabel ?? offer.model} via {fallbackName}
        {metered ? " using usage-based tokens" : ""}
        {resetsAt ? `, or wait until ${resetsAt}` : ""}?
      </span>
      {offer.restartsSession ? (
        <span className="text-xs text-foreground/70">
          {fallbackName} continues from a copy of this chat, so older detail may be lost.
        </span>
      ) : null}
    </div>
  );
});
