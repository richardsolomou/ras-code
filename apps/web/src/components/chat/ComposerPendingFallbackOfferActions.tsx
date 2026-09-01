import { type ApprovalRequestId, type ProviderFallbackOfferDecision } from "@ras-code/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingFallbackOfferActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToFallbackOffer: (
    requestId: ApprovalRequestId,
    decision: ProviderFallbackOfferDecision,
  ) => Promise<unknown>;
}

const FALLBACK_OFFER_OPTIONS = [
  { decision: "wait", label: "Wait for reset" },
  { decision: "switch", label: "Continue via PostHog" },
] as const satisfies ReadonlyArray<{
  decision: ProviderFallbackOfferDecision;
  label: string;
}>;

export const ComposerPendingFallbackOfferActions = memo(
  function ComposerPendingFallbackOfferActions({
    requestId,
    isResponding,
    onRespondToFallbackOffer,
  }: ComposerPendingFallbackOfferActionsProps) {
    return (
      <>
        {FALLBACK_OFFER_OPTIONS.map((option) => (
          <Button
            key={option.decision}
            size="default"
            variant={option.decision === "switch" ? "default" : "ghost-muted"}
            className="min-w-28"
            disabled={isResponding}
            onClick={() => void onRespondToFallbackOffer(requestId, option.decision)}
          >
            {option.label}
          </Button>
        ))}
      </>
    );
  },
);
