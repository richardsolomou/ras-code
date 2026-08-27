import type { ColorValue } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

/**
 * The brand wordmark, mirroring the desktop sidebar SVG (apps/web Sidebar.tsx).
 * Width derives from the viewBox aspect ratio.
 */
export function RasCodeWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  const aspectRatio = 92 / 78;
  return (
    <Svg
      accessibilityLabel="RAS Code"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="22 25 92 78"
    >
      <Path
        d="M36 96V32H68C77.9411 32 86 40.0589 86 50C86 59.9411 77.9411 68 68 68H36"
        fill="none"
        stroke={props.color}
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M60 68L82 96"
        stroke={props.color}
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Rect x={94} y={74} width={12} height={22} rx={2} fill={props.color} />
    </Svg>
  );
}
