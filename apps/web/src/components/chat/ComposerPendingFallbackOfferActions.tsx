import { type ApprovalRequestId, type ProviderFallbackOfferDecision } from "@ras-code/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingFallbackOfferActionsProps {
  requestId: ApprovalRequestId;
  /** Names the destination for screen readers. The panel above says it in full. */
  fallbackName: string;
  isResponding: boolean;
  onRespondToFallbackOffer: (
    requestId: ApprovalRequestId,
    decision: ProviderFallbackOfferDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingFallbackOfferActions = memo(
  function ComposerPendingFallbackOfferActions({
    requestId,
    fallbackName,
    isResponding,
    onRespondToFallbackOffer,
  }: ComposerPendingFallbackOfferActionsProps) {
    const options = [
      { decision: "wait", label: "Wait for reset", ariaLabel: "Wait for the usage limit to reset" },
      { decision: "switch", label: "Continue", ariaLabel: `Continue via ${fallbackName}` },
    ] as const satisfies ReadonlyArray<{
      decision: ProviderFallbackOfferDecision;
      label: string;
      ariaLabel: string;
    }>;
    return (
      <>
        {options.map((option) => (
          <Button
            key={option.decision}
            size="default"
            variant={option.decision === "switch" ? "default" : "ghost-muted"}
            className="min-w-28"
            aria-label={option.ariaLabel}
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
