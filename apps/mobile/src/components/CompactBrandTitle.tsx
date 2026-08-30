import Constants from "expo-constants";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { RasCodeWordmark } from "./RasCodeWordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useThemeColor } from "../lib/useThemeColor";

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
  } = {},
) {
  const wordmarkColor = useThemeColor("--color-wordmark");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset();

  return (
    <View
      aria-level={1}
      accessibilityLabel="RAS Code, Threads"
      accessible
      role="heading"
      style={{
        alignItems: "center",
        flexDirection: "row",
        gap: 6,
        marginLeft: titleOffset,
      }}
    >
      <RasCodeWordmark color={wordmarkColor} height={13} />
      {stageLabel ? (
        <View
          style={{
            backgroundColor: subtleColor,
            borderRadius: 999,
            paddingHorizontal: 6,
            paddingVertical: 2,
          }}
        >
          <Text
            allowFontScaling={props.allowFontScaling}
            style={{
              color: mutedColor,
              fontFamily: "BarlowSemiCondensed-SemiBold",
              fontSize: 9,
              letterSpacing: 0.9,
              textTransform: "uppercase",
            }}
          >
            {stageLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
