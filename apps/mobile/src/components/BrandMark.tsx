import Constants from "expo-constants";
import { View } from "react-native";
import Svg, { ClipPath, Defs, G, Rect } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { AppText as Text } from "./AppText";
import { BRAND_PALETTES } from "./brandPalette";

const ACTIVE_CELLS = new Map(
  [
    [2, 1, 3],
    [3, 1, 2],
    [2, 2, 2],
    [4, 2, 3],
    [2, 3, 3],
    [3, 3, 2],
    [2, 4, 1],
    [4, 4, 3],
    [2, 5, 2],
    [4, 5, 1],
  ].map(([column, row, level]) => [`${column},${row}`, level]),
);

const CELLS = Array.from({ length: 9 }, (_, row) =>
  Array.from({ length: 9 }, (_, column) => ({ column: column - 1, row: row - 1 })),
).flat();

const appVariant = Constants.expoConfig?.extra?.appVariant;

export function BrandMark(props: { readonly compact?: boolean }) {
  const { themeAppearance } = useAppearancePreferences();
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const palette = BRAND_PALETTES[themeAppearance];
  const stageLabel = resolveMobileStageLabel(appVariant);

  return (
    <View className="flex-row items-center gap-3">
      <Svg accessibilityLabel="RAS Code" height={iconSize} viewBox="0 0 128 128" width={iconSize}>
        <Rect
          fill={palette.background}
          height={127}
          rx={12}
          stroke={palette.border}
          width={127}
          x={0.5}
          y={0.5}
        />
        <Defs>
          <ClipPath id="brand-mark-boundary">
            <Rect height={127} rx={12} width={127} x={0.5} y={0.5} />
          </ClipPath>
        </Defs>
        <G clipPath="url(#brand-mark-boundary)">
          {CELLS.map(({ column, row }) => {
            const level = ACTIVE_CELLS.get(`${column},${row}`);
            return (
              <Rect
                fill={level === undefined ? palette.empty : palette.levels[level - 1]}
                height={12}
                key={`${column},${row}`}
                rx={2}
                width={12}
                x={10 + column * 16}
                y={10 + row * 16}
              />
            );
          })}
        </G>
      </Svg>
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-ras-code-bold tracking-[-0.4px] text-foreground">
            RAS Code
          </Text>
          {stageLabel ? (
            <View className="rounded-full bg-subtle px-2 py-1">
              <Text className="text-3xs font-ras-code-legend text-foreground-muted">
                {stageLabel}
              </Text>
            </View>
          ) : null}
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
