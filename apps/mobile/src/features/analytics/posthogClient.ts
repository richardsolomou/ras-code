import type { PostHog } from "posthog-react-native";

let client: PostHog | null = null;
let propertiesAfterReset: Parameters<PostHog["register"]>[0] | null = null;

export function setPostHogClient(
  nextClient: PostHog | null,
  nextPropertiesAfterReset: Parameters<PostHog["register"]>[0] | null = null,
): void {
  client = nextClient;
  propertiesAfterReset = nextPropertiesAfterReset;
}

function identifyPostHogUser(userId: string): void {
  client?.identify(userId);
}

function resetPostHogUser(): void {
  client?.reset();
  if (client && propertiesAfterReset) {
    client.register(propertiesAfterReset);
  }
}

export function transitionPostHogUser(
  previousUserId: string | null | undefined,
  nextUserId: string | null,
): void {
  if (previousUserId === nextUserId) {
    return;
  }
  if (nextUserId) {
    if (previousUserId) {
      resetPostHogUser();
    }
    identifyPostHogUser(nextUserId);
  } else if (previousUserId) {
    resetPostHogUser();
  }
}

export function capturePostHogScreen(screenName: string): void {
  client?.screen(screenName);
}
