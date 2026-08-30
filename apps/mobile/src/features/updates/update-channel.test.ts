import { describe, expect, it, vi } from "vite-plus/test";

import {
  MOBILE_UPDATE_CHANNEL_HEADER,
  resolveMobileUpdateChannel,
  switchMobileUpdateChannel,
  type MobileUpdateChannelClient,
} from "./update-channel";

vi.mock("expo-updates", () => ({
  channel: "production",
  reloadAsync: vi.fn(),
  setUpdateRequestHeadersOverride: vi.fn(),
}));

function makeChannelClient(
  overrides: Partial<MobileUpdateChannelClient> = {},
): MobileUpdateChannelClient {
  return {
    channel: "production",
    reloadAsync: vi.fn(async () => {}),
    setUpdateRequestHeadersOverride: vi.fn(),
    ...overrides,
  };
}

describe("resolveMobileUpdateChannel", () => {
  it("recognizes the canary track", () => {
    expect(resolveMobileUpdateChannel("canary")).toBe("canary");
  });

  it("has no track for a development client, which reports no channel", () => {
    expect(resolveMobileUpdateChannel(null)).toBeNull();
  });

  it("has no track for a channel this app does not publish to", () => {
    expect(resolveMobileUpdateChannel("preview")).toBeNull();
  });
});

describe("switchMobileUpdateChannel", () => {
  it("overrides the channel request header", async () => {
    const client = makeChannelClient();

    await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(client.setUpdateRequestHeadersOverride).toHaveBeenCalledWith({
      [MOBILE_UPDATE_CHANNEL_HEADER]: "canary",
    });
  });

  it("restarts so the new track takes effect", async () => {
    const client = makeChannelClient();

    await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(client.reloadAsync).toHaveBeenCalled();
  });

  it("does not restart when the app already follows the requested track", async () => {
    const client = makeChannelClient({ channel: "canary" });

    const result = await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(result).toEqual({ _tag: "Unchanged" });
  });

  it("leaves the track alone when pending state could not be saved", async () => {
    const client = makeChannelClient();

    await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {
        throw new Error("outbox is stuck");
      },
    });

    expect(client.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
  });

  it("reports why the override was rejected", async () => {
    const client = makeChannelClient({
      setUpdateRequestHeadersOverride: vi.fn(() => {
        throw new Error("not supported in development builds");
      }),
    });

    const result = await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(result).toEqual({
      _tag: "Failed",
      message: "not supported in development builds",
    });
  });

  it("does not restart after the override was rejected", async () => {
    const client = makeChannelClient({
      setUpdateRequestHeadersOverride: vi.fn(() => {
        throw new Error("not supported in development builds");
      }),
    });

    await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it("reports a failed restart as a track that still changes at the next launch", async () => {
    const client = makeChannelClient({
      reloadAsync: vi.fn(async () => {
        throw new Error("reload rejected");
      }),
    });

    const result = await switchMobileUpdateChannel({
      channel: "canary",
      client,
      flushPendingWrites: async () => {},
    });

    expect(result).toEqual({ _tag: "Failed", message: "reload rejected" });
  });
});
