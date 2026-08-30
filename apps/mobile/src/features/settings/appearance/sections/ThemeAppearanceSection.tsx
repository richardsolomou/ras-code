import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import {
  getMobileThemeVariables,
  type MobileThemeIds,
  type MobileThemeMode,
  type MobileThemeVariables,
} from "../../../../lib/mobileTheme";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const APPEARANCE_MODES: ReadonlyArray<{
  readonly id: MobileThemeMode;
  readonly label: string;
}> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function PreviewPane(props: { readonly colors: MobileThemeVariables; readonly compact?: boolean }) {
  return (
    <View
      className="flex-1 overflow-hidden"
      style={{ backgroundColor: props.colors["--color-screen"] }}
    >
      <View
        className={props.compact ? "h-[18px] gap-0.5 px-1" : "h-[18px] gap-1 px-1.5"}
        style={{ backgroundColor: props.colors["--color-card"] }}
      >
        <View className="mt-2 flex-row items-center gap-1">
          <View
            className="size-1.5 rounded-full"
            style={{ backgroundColor: props.colors["--color-primary"] }}
          />
          <View
            className="h-1 flex-1 rounded-full"
            style={{ backgroundColor: props.colors["--color-foreground-muted"] }}
          />
        </View>
      </View>
      <View
        className={
          props.compact ? "flex-1 justify-between px-1 py-2" : "flex-1 justify-between px-1.5 py-2"
        }
      >
        <View className="gap-1">
          <View
            className="h-1.5 w-[72%] rounded-full"
            style={{ backgroundColor: props.colors["--color-subtle-strong"] }}
          />
          <View
            className="h-1.5 w-[46%] rounded-full"
            style={{ backgroundColor: props.colors["--color-subtle-strong"] }}
          />
        </View>
        <View className="items-end gap-1 pb-2">
          <View
            className="h-3 w-[78%] rounded-full"
            style={{ backgroundColor: props.colors["--color-user-bubble"] }}
          />
          <View
            className="h-1 w-[38%] rounded-full"
            style={{ backgroundColor: props.colors["--color-foreground-muted"] }}
          />
        </View>
      </View>
    </View>
  );
}

function ModePreview(props: { readonly mode: MobileThemeMode; readonly themeIds: MobileThemeIds }) {
  const light = getMobileThemeVariables(props.themeIds.light, "light");
  const dark = getMobileThemeVariables(props.themeIds.dark, "dark");
  const currentBorder = useThemeColor("--color-border");
  const currentFrame = useThemeColor("--color-drawer");
  const currentIndicator = useThemeColor("--color-foreground-muted");
  const frameColor =
    props.mode === "light"
      ? light["--color-border"]
      : props.mode === "dark"
        ? dark["--color-border"]
        : currentBorder;
  const frameBackground =
    props.mode === "light"
      ? light["--color-drawer"]
      : props.mode === "dark"
        ? dark["--color-drawer"]
        : currentFrame;
  const indicatorColor =
    props.mode === "light"
      ? light["--color-foreground-muted"]
      : props.mode === "dark"
        ? dark["--color-foreground-muted"]
        : currentIndicator;

  return (
    <View
      className="h-24 w-14 self-center rounded-[16px] p-[3px]"
      style={{ backgroundColor: frameBackground, borderColor: frameColor, borderWidth: 1.5 }}
    >
      <View className="flex-1 flex-row overflow-hidden rounded-[11px]">
        {props.mode === "system" ? (
          <>
            <PreviewPane colors={light} compact />
            <PreviewPane colors={dark} compact />
          </>
        ) : (
          <PreviewPane colors={props.mode === "light" ? light : dark} />
        )}
      </View>
      <View
        className="absolute bottom-[6px] left-1/2 h-1 w-4 -translate-x-1/2 rounded-full"
        style={{ backgroundColor: indicatorColor }}
      />
    </View>
  );
}

function ModeCard(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly mode: MobileThemeMode;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly themeIds: MobileThemeIds;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label} appearance`}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.selected
          ? "min-w-0 flex-1 gap-2 rounded-[24px] border-2 border-primary bg-subtle p-2"
          : "min-w-0 flex-1 gap-2 rounded-[24px] border border-border bg-card p-2"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <ModePreview mode={props.mode} themeIds={props.themeIds} />
      <Text
        className={
          props.selected
            ? "text-center text-base font-ras-code-bold text-foreground"
            : "text-center text-base text-foreground-muted"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ThemeAppearanceSection() {
  const { isReady, setThemeMode, themeIds, themeMode } = useAppearancePreferences();

  return (
    <View accessibilityRole="radiogroup" className="flex-row gap-2">
      {APPEARANCE_MODES.map((mode) => (
        <ModeCard
          disabled={!isReady}
          key={mode.id}
          label={mode.label}
          mode={mode.id}
          onPress={() => setThemeMode(mode.id)}
          selected={mode.id === themeMode}
          themeIds={themeIds}
        />
      ))}
    </View>
  );
}
