import { describe, expect, it } from "vite-plus/test";

import {
  channelCookie,
  proxyUrl,
  readChannelCookie,
  routeRequest,
  type WebRouterConfig,
} from "./worker.ts";

const ROUTER: WebRouterConfig = {
  routerHost: "code.ras.sh",
  nightlyOrigin: "https://code-nightly.ras.sh",
};
const NIGHTLY_DEPLOYMENT: WebRouterConfig = {};

const route = (url: string, cookie: string | null, config: WebRouterConfig = ROUTER) =>
  routeRequest(new URL(url), cookie, config);

describe("routeRequest", () => {
  it("opts into the nightly channel", () => {
    expect(route("https://code.ras.sh/__ras-code/channel?channel=nightly", null)).toEqual({
      kind: "set-channel",
      channel: "nightly",
    });
  });

  it("treats any other channel value as latest", () => {
    expect(route("https://code.ras.sh/__ras-code/channel?channel=banana", null)).toEqual({
      kind: "set-channel",
      channel: "latest",
    });
  });

  it("opts back into latest when no channel is given", () => {
    expect(route("https://code.ras.sh/__ras-code/channel", null)).toEqual({
      kind: "set-channel",
      channel: "latest",
    });
  });

  it("hands the router host to nightly when the cookie says so", () => {
    expect(route("https://code.ras.sh/threads/1", "ras_code_web_channel=nightly")).toEqual({
      kind: "proxy",
      origin: "https://code-nightly.ras.sh",
    });
  });

  it("serves its own assets on the router host without a cookie", () => {
    expect(route("https://code.ras.sh/threads/1", null)).toEqual({ kind: "assets" });
  });

  it("serves its own assets on the router host when the cookie says latest", () => {
    expect(route("https://code.ras.sh/threads/1", "ras_code_web_channel=latest")).toEqual({
      kind: "assets",
    });
  });

  it("never proxies a channel domain, so a nightly cookie cannot loop", () => {
    expect(route("https://code-latest.ras.sh/", "ras_code_web_channel=nightly")).toEqual({
      kind: "assets",
    });
  });

  it("serves assets on the nightly deployment, which has no router config", () => {
    expect(
      route("https://code-nightly.ras.sh/", "ras_code_web_channel=nightly", NIGHTLY_DEPLOYMENT),
    ).toEqual({ kind: "assets" });
  });
});

describe("readChannelCookie", () => {
  it("finds the channel alongside other cookies", () => {
    expect(readChannelCookie("foo=1; ras_code_web_channel=nightly; bar=2")).toBe("nightly");
  });

  it("ignores a channel value it does not recognize", () => {
    expect(readChannelCookie("ras_code_web_channel=beta")).toBeNull();
  });

  it("ignores a cookie whose name merely ends with the channel name", () => {
    expect(readChannelCookie("other_ras_code_web_channel=nightly")).toBeNull();
  });

  it("returns null when the header is absent", () => {
    expect(readChannelCookie(null)).toBeNull();
  });
});

describe("channelCookie", () => {
  it("scopes the cookie to the whole site and keeps it off client scripts", () => {
    expect(channelCookie("nightly")).toBe(
      "ras_code_web_channel=nightly; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax",
    );
  });
});

describe("proxyUrl", () => {
  it("preserves the path and query against the upstream origin", () => {
    expect(
      proxyUrl(new URL("https://code.ras.sh/threads/1?tab=diff"), "https://code-nightly.ras.sh"),
    ).toBe("https://code-nightly.ras.sh/threads/1?tab=diff");
  });
});
