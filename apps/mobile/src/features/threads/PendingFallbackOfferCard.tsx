import {
  type ApprovalRequestId,
  type ProviderFallbackOfferDecision,
  type ServerProvider,
} from "@ras-code/contracts";
import {
  fallbackInstanceIsMetered,
  fallbackInstanceLabel,
} from "@ras-code/client-runtime/provider-fallback";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingFallbackOffer } from "../../lib/threadActivity";

interface PendingFallbackOfferCardProps {
  readonly offer: PendingFallbackOffer;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly respondingFallbackId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderFallbackOfferDecision,
  ) => Promise<unknown>;
}

export function PendingFallbackOfferCard(props: PendingFallbackOfferCardProps) {
  const primaryName = fallbackInstanceLabel(props.providers, props.offer.primaryInstanceId);
  const fallbackName = fallbackInstanceLabel(props.providers, props.offer.fallbackInstanceId);
  const metered = fallbackInstanceIsMetered(props.providers, props.offer.fallbackInstanceId);
  const disabled = props.respondingFallbackId === props.offer.requestId;

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-ras-code-legend text-2xs text-[#8a6a12] dark:text-[#f0c24b]">
        Usage limit reached
      </Text>
      <Text className="font-ras-code-bold text-lg text-neutral-950 dark:text-neutral-50">
        {primaryName} hit its usage limit
      </Text>
      <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
        Continue with {props.offer.modelLabel ?? props.offer.model} via {fallbackName}
        {metered ? " using usage-based tokens" : ""}, or wait for the subscription to reset?
      </Text>
      {props.offer.restartsSession ? (
        <Text className="font-sans text-xs leading-normal text-neutral-500 dark:text-neutral-500">
          {fallbackName} continues from a copy of this chat, so older detail may be lost.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          accessibilityLabel="Wait for subscription reset"
          accessibilityRole="button"
          className="items-center justify-center rounded-[14px] bg-neutral-200 px-3.5 py-3 dark:bg-neutral-800"
          disabled={disabled}
          onPress={() => void props.onRespond(props.offer.requestId, "wait")}
        >
          <Text className="font-ras-code-bold text-sm text-neutral-950 dark:text-neutral-50">
            Wait for reset
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={`Continue via ${fallbackName}`}
          accessibilityRole="button"
          className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
          disabled={disabled}
          onPress={() => void props.onRespond(props.offer.requestId, "switch")}
        >
          <Text className="font-ras-code-extrabold text-sm text-white">Continue</Text>
        </Pressable>
      </View>
    </View>
  );
}
