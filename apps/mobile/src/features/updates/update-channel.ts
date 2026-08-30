import * as Updates from "expo-updates";

import { flushPendingAppWrites } from "./app-updates";

/** The EAS Update channels a store build can follow. */
export type MobileUpdateChannel = "production" | "canary";

export const MOBILE_UPDATE_CHANNEL_HEADER = "expo-channel-name";

/**
 * The channel every store binary is built with. Following it means clearing the
 * override rather than setting another one, which puts expo-updates back in its
 * factory state — including the cache hygiene it skips while an override is in
 * force.
 */
const EMBEDDED_CHANNEL: MobileUpdateChannel = "production";

/**
 * The pieces of expo-updates a track switch needs. Injectable so the flow stays
 * unit-testable without the native module.
 */
export interface MobileUpdateChannelClient {
  readonly channel: string | null;
  readonly setUpdateRequestHeadersOverride: (headers: Record<string, string> | null) => void;
  readonly fetchUpdateAsync: () => Promise<Updates.UpdateFetchResult>;
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

/** What the download before the restart turned up, kept to explain a failed restart. */
type TrackFetch =
  | { readonly _tag: "Downloaded" }
  | { readonly _tag: "NothingToDownload" }
  | { readonly _tag: "Unreachable"; readonly message: string };

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
 * Repoints the updater at another track, then restarts so the change takes
 * effect.
 *
 * The download is not optional. expo-updates stamps the channel request headers
 * onto every update as it writes it to disk, and refuses to launch one whose
 * stamp does not match the current configuration — the embedded bundle
 * included. So until the new track has been fetched at least once there is
 * usually nothing on the device it could launch, and a bare restart fails.
 */
export async function switchMobileUpdateChannel(
  options: SwitchOptions,
): Promise<MobileUpdateChannelSwitch> {
  const client = options.client ?? Updates;
  const current = resolveMobileUpdateChannel(client.channel);
  if (current === options.channel) {
    return { _tag: "Unchanged" };
  }

  const flushPendingWrites = options.flushPendingWrites ?? flushPendingAppWrites;
  try {
    await flushPendingWrites();
  } catch (error) {
    // Nothing has changed yet, so keep the runtime holding the unsaved state.
    return failure(error, "Could not save pending state.");
  }

  const follow = (channel: MobileUpdateChannel | null) => {
    client.setUpdateRequestHeadersOverride(
      channel === null || channel === EMBEDDED_CHANNEL
        ? null
        : { [MOBILE_UPDATE_CHANNEL_HEADER]: channel },
    );
  };

  try {
    follow(options.channel);
  } catch (error) {
    return failure(error, "Could not switch the update track.");
  }

  // Best effort: coming back to a track the device has already launched needs no
  // download, so a fetch that finds nothing is only a problem if the restart
  // then fails too.
  const fetched = await fetchTrack(client);

  try {
    await client.reloadAsync();
  } catch {
    try {
      follow(current);
    } catch {
      // The override only steers the next update check, and this call is
      // already reporting a failure.
    }
    return { _tag: "Failed", message: restartFailure(fetched, options.channel) };
  }

  return { _tag: "Switched" };
}

async function fetchTrack(client: MobileUpdateChannelClient): Promise<TrackFetch> {
  let result: Updates.UpdateFetchResult;
  try {
    result = await client.fetchUpdateAsync();
  } catch (error) {
    return {
      _tag: "Unreachable",
      message:
        error instanceof Error && error.message
          ? error.message
          : "Could not reach the update server.",
    };
  }
  // A rollback tells the app to run its own bundle, so this track still put
  // nothing new on the device.
  return result.isNew ? { _tag: "Downloaded" } : { _tag: "NothingToDownload" };
}

/**
 * Says why the restart failed in terms of the track. The native reload error
 * names an unrelated iOS property and never mentions channels, so the download
 * that came first is the only useful evidence.
 */
function restartFailure(fetched: TrackFetch, channel: MobileUpdateChannel): string {
  const label = mobileUpdateChannelLabel(channel);
  switch (fetched._tag) {
    case "Unreachable":
      return `Could not switch to ${label}: ${fetched.message}`;
    case "NothingToDownload":
      return `${label} has no build for this version of the app yet. It arrives with the next build.`;
    case "Downloaded":
      return `Could not restart on ${label}, so RAS Code stayed where it was.`;
  }
}

function failure(error: unknown, fallback: string): MobileUpdateChannelSwitch {
  return {
    _tag: "Failed",
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}
