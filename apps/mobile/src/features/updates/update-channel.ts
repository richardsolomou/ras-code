import * as Updates from "expo-updates";

import { flushPendingAppWrites } from "./app-updates";

/** The EAS Update channels a store build can follow. */
export type MobileUpdateChannel = "production" | "canary";

export const MOBILE_UPDATE_CHANNEL_HEADER = "expo-channel-name";

/**
 * The pieces of expo-updates a track switch needs. Injectable so the flow stays
 * unit-testable without the native module.
 */
export interface MobileUpdateChannelClient {
  readonly channel: string | null;
  readonly setUpdateRequestHeadersOverride: (headers: Record<string, string> | null) => void;
  readonly reloadAsync: () => Promise<void>;
}

export type MobileUpdateChannelSwitch =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Switched" }
  | { readonly _tag: "Failed"; readonly message: string };

interface SwitchOptions {
  readonly channel: MobileUpdateChannel;
  readonly client?: MobileUpdateChannelClient;
  readonly flushPendingWrites?: () => Promise<void>;
}

/**
 * The track this binary is currently following, or `null` where switching does
 * not apply: development clients, preview builds, and Expo Go all report a
 * channel this app does not publish to.
 */
export function resolveMobileUpdateChannel(
  channel: string | null | undefined,
): MobileUpdateChannel | null {
  return channel === "production" || channel === "canary" ? channel : null;
}

export function mobileUpdateChannelLabel(channel: MobileUpdateChannel): string {
  return channel === "canary" ? "Canary" : "Stable";
}

/**
 * Repoints the updater at another track by overriding the channel request
 * header, then restarts so the change takes effect.
 *
 * The override is persisted natively, and expo-updates only launches updates
 * whose stored request headers match the current configuration, so the restart
 * leaves the other track's downloaded bundle behind instead of stranding it.
 */
export async function switchMobileUpdateChannel(
  options: SwitchOptions,
): Promise<MobileUpdateChannelSwitch> {
  const client = options.client ?? Updates;
  if (resolveMobileUpdateChannel(client.channel) === options.channel) {
    return { _tag: "Unchanged" };
  }

  const flushPendingWrites = options.flushPendingWrites ?? flushPendingAppWrites;
  try {
    await flushPendingWrites();
  } catch (error) {
    // Nothing has changed yet, so keep the runtime holding the unsaved state.
    return failure(error, "Could not save pending state.");
  }

  try {
    client.setUpdateRequestHeadersOverride({ [MOBILE_UPDATE_CHANNEL_HEADER]: options.channel });
  } catch (error) {
    return failure(error, "Could not switch the update track.");
  }

  try {
    await client.reloadAsync();
  } catch (error) {
    // The override survives the process, so the track still changes at the next
    // launch even though this restart did not happen.
    return failure(error, "Switched the update track, but could not restart the app.");
  }

  return { _tag: "Switched" };
}

function failure(error: unknown, fallback: string): MobileUpdateChannelSwitch {
  return {
    _tag: "Failed",
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}
