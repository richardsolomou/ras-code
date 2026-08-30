import {
  PROVIDER_DISPLAY_NAMES,
  type ApprovalRequestId,
  type ProviderFallbackOfferDecision,
  type ServerProvider,
} from "@ras-code/contracts";
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

function instanceName(instanceId: string, providers: ReadonlyArray<ServerProvider>): string {
  const provider = providers.find((entry) => String(entry.instanceId) === instanceId);
  return (
    provider?.displayName ??
    (provider ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ??
    instanceId
  );
}

export function PendingFallbackOfferCard(props: PendingFallbackOfferCardProps) {
  const primaryName = instanceName(props.offer.primaryInstanceId, props.providers);
  const fallbackName = instanceName(props.offer.fallbackInstanceId, props.providers);
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
        Continue with {props.offer.modelLabel ?? props.offer.model} via {fallbackName} using
        usage-based tokens, or wait for the subscription to reset?
      </Text>
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
          accessibilityLabel="Continue via PostHog AI Gateway"
          accessibilityRole="button"
          className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
          disabled={disabled}
          onPress={() => void props.onRespond(props.offer.requestId, "switch")}
        >
          <Text className="font-ras-code-extrabold text-sm text-white">Continue via PostHog</Text>
        </Pressable>
      </View>
    </View>
  );
}
