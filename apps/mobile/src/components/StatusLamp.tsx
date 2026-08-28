import { View } from "react-native";

/**
 * Console state channel. Colour carries the state and the caller's label
 * repeats it, so a lamp stays readable without colour. `idle` is a station at
 * rest; `settled` is the explicit "done, not archived" state and shows no lamp.
 */
export type LampState = "working" | "waiting" | "failed" | "settled" | "idle";

const LAMP_SIZE = 10;

const LAMP_COLORS: Record<Exclude<LampState, "settled">, string> = {
  working: "#52c46f",
  waiting: "#f0c24b",
  failed: "#e5645a",
  idle: "#3a3646",
};

export function StatusLamp(props: { readonly state: LampState; readonly size?: number }) {
  if (props.state === "settled") return null;

  const size = props.size ?? LAMP_SIZE;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        borderWidth: 1,
        borderColor: "rgba(0, 0, 0, 0.32)",
        backgroundColor: LAMP_COLORS[props.state],
      }}
    />
  );
}
