import * as Updates from "expo-updates";
import type { PropsWithChildren } from "react";
import { PostHog, PostHogProvider } from "posthog-react-native";

import { setPostHogClient } from "./posthogClient";

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY?.trim();
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim();
const releaseProperties = {
  expo_update_id: Updates.updateId,
  expo_channel: Updates.channel,
  expo_runtime_version: Updates.runtimeVersion,
};

const posthog =
  apiKey && host
    ? new PostHog(apiKey, {
        host,
        captureAppLifecycleEvents: false,
        enableSessionReplay: true,
        sessionReplayConfig: {
          maskAllTextInputs: true,
          maskAllImages: true,
          maskAllSandboxedViews: true,
          captureLog: false,
          captureNetworkTelemetry: false,
        },
        errorTracking: {
          autocapture: {
            uncaughtExceptions: true,
            unhandledRejections: true,
          },
        },
        capturePushNotificationSubscriptions: false,
        capturePushNotificationOpened: false,
      })
    : null;

setPostHogClient(posthog, releaseProperties);
posthog?.register(releaseProperties);

export function PostHogAppProvider(props: PropsWithChildren) {
  if (!posthog) {
    return props.children;
  }

  return (
    <PostHogProvider
      client={posthog}
      autocapture={{ captureScreens: false, captureTouches: false }}
    >
      {props.children}
    </PostHogProvider>
  );
}
