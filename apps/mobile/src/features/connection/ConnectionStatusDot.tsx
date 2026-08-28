import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import type { RemoteClientConnectionState } from "../../lib/connection";

export type ConnectionStatusDotState = RemoteClientConnectionState;

function statusDotTone(state: ConnectionStatusDotState): {
  readonly dotColor: string;
  readonly haloColor: string;
} {
  switch (state) {
    case "available":
      return {
        dotColor: "#3a3646",
        haloColor: "rgba(58,54,70,0.42)",
      };
    case "connected":
      return {
        dotColor: "#52c46f",
        haloColor: "rgba(82,196,111,0.48)",
      };
    case "connecting":
    case "reconnecting":
      return {
        dotColor: "#f0c24b",
        haloColor: "rgba(240,194,75,0.5)",
      };
    case "offline":
    case "error":
      return {
        dotColor: "#e5645a",
        haloColor: "rgba(229,100,90,0.48)",
      };
  }
}

function usePulseAnimation(pulse: boolean) {
  const pulseProgress = useSharedValue(0);

  useEffect(() => {
    if (pulse) {
      pulseProgress.value = withRepeat(
        withTiming(1, {
          duration: 1100,
          easing: Easing.out(Easing.cubic),
        }),
        -1,
        false,
      );
      return;
    }

    cancelAnimation(pulseProgress);
    pulseProgress.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.quad),
    });
  }, [pulse, pulseProgress]);

  return pulseProgress;
}

export function ConnectionStatusDot(props: {
  readonly state: ConnectionStatusDotState;
  readonly pulse: boolean;
  readonly size?: number;
}) {
  const pulseProgress = usePulseAnimation(props.pulse);
  const tone = statusDotTone(props.state);
  const dotSize = props.size ?? 10;
  const haloSize = dotSize + 4;
  const containerSize = haloSize + 4;

  const haloStyle = useAnimatedStyle(() => ({
    opacity: props.pulse ? 0.14 + (1 - pulseProgress.value) * 0.3 : 0,
    transform: [{ scale: 0.78 + pulseProgress.value * 1.16 }],
  }));

  return (
    <View
      style={{
        width: containerSize,
        height: containerSize,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          haloStyle,
          {
            position: "absolute",
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            backgroundColor: tone.haloColor,
          },
        ]}
      />
      <View
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: tone.dotColor,
        }}
      />
    </View>
  );
}
