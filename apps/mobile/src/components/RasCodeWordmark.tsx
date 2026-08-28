import type { ColorValue } from "react-native";
import Svg, { Rect } from "react-native-svg";

/**
 * The brand wordmark, mirroring the desktop sidebar SVG (apps/web Sidebar.tsx).
 * Width derives from the viewBox aspect ratio.
 */
export function RasCodeWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  const aspectRatio = 66 / 114;
  return (
    <Svg
      accessibilityLabel="RAS Code"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="31 7 66 114"
    >
      <Rect x={31} y={7} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={55} y={7} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={79} y={7} width={18} height={18} rx={3} fill={props.color} opacity={0.28} />
      <Rect x={31} y={31} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={55} y={31} width={18} height={18} rx={3} fill={props.color} opacity={0.28} />
      <Rect x={79} y={31} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={31} y={55} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={55} y={55} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={79} y={55} width={18} height={18} rx={3} fill={props.color} opacity={0.28} />
      <Rect x={31} y={79} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={55} y={79} width={18} height={18} rx={3} fill={props.color} opacity={0.28} />
      <Rect x={79} y={79} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={31} y={103} width={18} height={18} rx={3} fill="#F0C24B" />
      <Rect x={55} y={103} width={18} height={18} rx={3} fill={props.color} opacity={0.28} />
      <Rect x={79} y={103} width={18} height={18} rx={3} fill="#F0C24B" />
    </Svg>
  );
}
