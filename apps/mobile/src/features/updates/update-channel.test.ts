import { describe, expect, it, vi } from "vite-plus/test";

import {
  MOBILE_UPDATE_CHANNEL_HEADER,
  resolveMobileUpdateChannel,
  switchMobileUpdateChannel,
  type MobileUpdateChannelClient,
} from "./update-channel";

vi.mock("expo-updates", () => ({
  channel: "production",
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
  setUpdateRequestHeadersOverride: vi.fn(),
}));

const downloaded = { isNew: true, isRollBackToEmbedded: false, manifest: {} } as never;
const nothingToDownload = { isNew: false, isRollBackToEmbedded: false } as never;
const rollBackToEmbedded = { isNew: false, isRollBackToEmbedded: true } as never;

function makeChannelClient(
  overrides: Partial<MobileUpdateChannelClient> = {},
): MobileUpdateChannelClient {
  return {
    channel: "production",
    fetchUpdateAsync: vi.fn(async () => downloaded),
    reloadAsync: vi.fn(async () => {}),
    setUpdateRequestHeadersOverride: vi.fn(),
    ...overrides,
  };
}

function switchTo(channel: "production" | "canary", client: MobileUpdateChannelClient) {
  return switchMobileUpdateChannel({ channel, client, flushPendingWrites: async () => {} });
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

    await switchTo("canary", client);

    expect(client.setUpdateRequestHeadersOverride).toHaveBeenCalledWith({
      [MOBILE_UPDATE_CHANNEL_HEADER]: "canary",
    });
  });

  it("clears the override rather than setting one when returning to stable", async () => {
    const client = makeChannelClient({ channel: "canary" });

    await switchTo("production", client);

    expect(client.setUpdateRequestHeadersOverride).toHaveBeenCalledWith(null);
  });

  it("downloads the track before restarting, because nothing on disk can launch it yet", async () => {
    const order: string[] = [];
    const client = makeChannelClient({
      fetchUpdateAsync: vi.fn(async () => {
        order.push("fetch");
        return downloaded;
      }),
      reloadAsync: vi.fn(async () => {
        order.push("reload");
      }),
    });

    await switchTo("canary", client);

    expect(order).toEqual(["fetch", "reload"]);
  });

  it("does not restart when the app already follows the requested track", async () => {
    const client = makeChannelClient({ channel: "canary" });

    const result = await switchTo("canary", client);

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

    const result = await switchTo("canary", client);

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

    await switchTo("canary", client);

    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it("still switches when the download finds nothing but the device can launch the track anyway", async () => {
    const client = makeChannelClient({
      channel: "canary",
      fetchUpdateAsync: vi.fn(async () => nothingToDownload),
    });

    const result = await switchTo("production", client);

    expect(result).toEqual({ _tag: "Switched" });
  });

  it("still switches when the update server is unreachable, so returning to stable works offline", async () => {
    const client = makeChannelClient({
      channel: "canary",
      fetchUpdateAsync: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    const result = await switchTo("production", client);

    expect(result).toEqual({ _tag: "Switched" });
  });

  it("blames a track with no build when the restart fails after downloading nothing", async () => {
    const client = makeChannelClient({
      fetchUpdateAsync: vi.fn(async () => nothingToDownload),
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application");
      }),
    });

    const result = await switchTo("canary", client);

    expect(result).toEqual({
      _tag: "Failed",
      message:
        "Canary has no build for this version of the app yet. It arrives with the next build.",
    });
  });

  it("treats a rollback to the embedded bundle as nothing downloaded", async () => {
    const client = makeChannelClient({
      fetchUpdateAsync: vi.fn(async () => rollBackToEmbedded),
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application");
      }),
    });

    const result = await switchTo("canary", client);

    expect(result).toEqual({
      _tag: "Failed",
      message:
        "Canary has no build for this version of the app yet. It arrives with the next build.",
    });
  });

  it("blames the unreachable server when the restart fails after a failed download", async () => {
    const client = makeChannelClient({
      fetchUpdateAsync: vi.fn(async () => {
        throw new Error("offline");
      }),
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application");
      }),
    });

    const result = await switchTo("canary", client);

    expect(result).toEqual({ _tag: "Failed", message: "Could not switch to Canary: offline" });
  });

  it("does not pass the native restart message through, since it names an unrelated property", async () => {
    const client = makeChannelClient({
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application. Ensure you have set the `appContext`");
      }),
    });

    const result = await switchTo("canary", client);

    expect(result).toEqual({
      _tag: "Failed",
      message: "Could not restart on Canary, so RAS Code stayed where it was.",
    });
  });

  it("puts the app back on the track it came from when the restart fails", async () => {
    const client = makeChannelClient({
      channel: "canary",
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application");
      }),
    });

    await switchTo("production", client);

    expect(client.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
      [MOBILE_UPDATE_CHANNEL_HEADER]: "canary",
    });
  });

  it("clears the override again when the restart onto canary fails", async () => {
    const client = makeChannelClient({
      reloadAsync: vi.fn(async () => {
        throw new Error("Could not reload application");
      }),
    });

    await switchTo("canary", client);

    expect(client.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  });
});
