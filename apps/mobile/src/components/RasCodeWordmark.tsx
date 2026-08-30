import Svg, { Rect } from "react-native-svg";
import { memo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { BRAND_PALETTES } from "./brandPalette";

const ACTIVE_CELLS = new Map(
  [
    [1, 1, 3],
    [2, 1, 2],
    [6, 1, 3],
    [9, 1, 1],
    [10, 1, 2],
    [11, 1, 3],
    [1, 2, 2],
    [3, 2, 3],
    [5, 2, 2],
    [7, 2, 3],
    [9, 2, 2],
    [1, 3, 3],
    [2, 3, 2],
    [5, 3, 3],
    [6, 3, 2],
    [7, 3, 1],
    [9, 3, 3],
    [10, 3, 2],
    [11, 3, 1],
    [1, 4, 1],
    [3, 4, 3],
    [5, 4, 1],
    [7, 4, 3],
    [11, 4, 3],
    [1, 5, 2],
    [3, 5, 1],
    [5, 5, 2],
    [7, 5, 1],
    [9, 5, 1],
    [10, 5, 2],
    [11, 5, 3],
  ].map(([column, row, level]) => [`${column},${row}`, level]),
);

const CELLS = Array.from({ length: 7 }, (_, row) =>
  Array.from({ length: 13 }, (_, column) => ({ column, row })),
).flat();

export const RasCodeWordmark = memo(function RasCodeWordmark(props: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  const palette = BRAND_PALETTES[themeAppearance];

  return (
    <Svg
      accessibilityLabel="RAS"
      height={props.height}
      viewBox="0 0 138 78"
      width={(props.height * 138) / 78}
    >
      <Rect
        fill={palette.background}
        height={77}
        rx={8}
        stroke={palette.border}
        width={137}
        x={0.5}
        y={0.5}
      />
      {CELLS.map(({ column, row }) => {
        const level = ACTIVE_CELLS.get(`${column},${row}`);
        return (
          <Rect
            fill={level === undefined ? palette.empty : palette.levels[level - 1]}
            height={8}
            key={`${column},${row}`}
            rx={1.5}
            width={8}
            x={5 + column * 10}
            y={5 + row * 10}
          />
        );
      })}
    </Svg>
  );
});
