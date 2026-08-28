import type { ColorValue } from "react-native";
import Svg, { Rect } from "react-native-svg";

/**
 * The brand wordmark: RAS spelled in console lamps on a 3x5 grid, mirroring the
 * web sidebar mark. Width derives from the viewBox aspect ratio.
 */
export function RasCodeWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  const aspectRatio = 234 / 114;
  return (
    <Svg
      accessibilityLabel="RAS"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 234 114"
    >
      <Rect x={0} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={24} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={0} y={24} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={48} y={24} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={0} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={24} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={0} y={72} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={48} y={72} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={0} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={48} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={108} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={84} y={24} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={132} y={24} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={84} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={108} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={132} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={84} y={72} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={132} y={72} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={84} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={132} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={168} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={192} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={216} y={0} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={168} y={24} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={168} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={192} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={216} y={48} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={216} y={72} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={168} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={192} y={96} width={18} height={18} rx={3} fill={props.color} />
      <Rect x={216} y={96} width={18} height={18} rx={3} fill={props.color} />
    </Svg>
  );
}
