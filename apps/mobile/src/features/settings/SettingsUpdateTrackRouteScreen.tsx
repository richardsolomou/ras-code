import { useNavigation } from "@react-navigation/native";
import * as Updates from "expo-updates";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  mobileUpdateChannelLabel,
  resolveMobileUpdateChannel,
  switchMobileUpdateChannel,
  type MobileUpdateChannel,
} from "../updates/update-channel";
import { SettingsSection } from "./components/SettingsSection";

const TRACK_OPTIONS: ReadonlyArray<{
  readonly channel: MobileUpdateChannel;
  readonly description: string;
}> = [
  {
    channel: "production",
    description: "Follows the daily release.",
  },
  {
    channel: "canary",
    description: "Follows every change merged to main, and can switch back to stable immediately.",
  },
];

export function SettingsUpdateTrackRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const checkmarkColor = useThemeColor("--color-icon");
  const [selectedChannel, setSelectedChannel] = useState(() =>
    resolveMobileUpdateChannel(Updates.channel),
  );
  const [switching, setSwitching] = useState(false);
  // `switching` only flips after the alert is answered, so without this the
  // same row tapped twice stacks two prompts.
  const promptOpen = useRef(false);

  const switchTrack = useCallback(async (channel: MobileUpdateChannel) => {
    setSwitching(true);
    // Optimistic: a successful switch restarts the app, so the only render this
    // ever reaches is the failure path below.
    setSelectedChannel(channel);
    const result = await switchMobileUpdateChannel({ channel });
    if (result._tag === "Failed") {
      setSelectedChannel(resolveMobileUpdateChannel(Updates.channel));
      Alert.alert("Could not switch update track", result.message);
    }
    setSwitching(false);
  }, []);

  const confirmSwitch = useCallback(
    (channel: MobileUpdateChannel) => {
      if (switching || promptOpen.current || channel === selectedChannel) return;
      promptOpen.current = true;
      const dismiss = () => {
        promptOpen.current = false;
      };
      Alert.alert(
        `Switch to ${mobileUpdateChannelLabel(channel)}?`,
        "RAS Code restarts and downloads this track in the background. Unsent drafts and queued messages are saved first.",
        [
          { onPress: dismiss, style: "cancel", text: "Cancel" },
          {
            onPress: () => {
              dismiss();
              void switchTrack(channel);
            },
            text: "Switch",
          },
        ],
        { cancelable: true, onDismiss: dismiss },
      );
    },
    [selectedChannel, switchTrack, switching],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Update Track" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Updates follow">
          {TRACK_OPTIONS.map((option, index) => (
            <Pressable
              key={option.channel}
              accessibilityRole="radio"
              accessibilityState={{
                checked: selectedChannel === option.channel,
                disabled: switching,
              }}
              disabled={switching}
              onPress={() => confirmSwitch(option.channel)}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">
                  {mobileUpdateChannelLabel(option.channel)}
                </Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  {option.description}
                </Text>
              </View>
              {selectedChannel === option.channel ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
