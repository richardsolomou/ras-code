import { describe, expect, it } from "vite-plus/test";

import {
  channelCookie,
  proxyUrl,
  readChannelCookie,
  isHostedAppPath,
  legacyRedirectLocation,
  routeRequest,
  type WebRouterConfig,
} from "./worker.ts";
import worker from "./worker.ts";

const ROUTER: WebRouterConfig = {
  routerHost: "code.ras.sh",
  canaryOrigin: "https://code-canary.ras.sh",
};
const CANARY_DEPLOYMENT: WebRouterConfig = {};

const route = (url: string, cookie: string | null, config: WebRouterConfig = ROUTER) =>
  routeRequest(new URL(url), cookie, config);

describe("routeRequest", () => {
  it("opts into the canary channel", () => {
    expect(route("https://code.ras.sh/app/__ras-code/channel?channel=canary", null)).toEqual({
      kind: "set-channel",
      channel: "canary",
    });
  });

  it("treats any other channel value as latest", () => {
    expect(route("https://code.ras.sh/app/__ras-code/channel?channel=banana", null)).toEqual({
      kind: "set-channel",
      channel: "latest",
    });
  });

  it("opts back into latest when no channel is given", () => {
    expect(route("https://code.ras.sh/app/__ras-code/channel", null)).toEqual({
      kind: "set-channel",
      channel: "latest",
    });
  });

  it("hands the router host to canary when the cookie says so", () => {
    expect(route("https://code.ras.sh/app/threads/1", "ras_code_web_channel=canary")).toEqual({
      kind: "proxy",
      origin: "https://code-canary.ras.sh",
    });
  });

  it("serves its own assets on the router host without a cookie", () => {
    expect(route("https://code.ras.sh/app/threads/1", null)).toEqual({ kind: "assets" });
  });

  it("serves its own assets on the router host when the cookie says latest", () => {
    expect(route("https://code.ras.sh/app/threads/1", "ras_code_web_channel=latest")).toEqual({
      kind: "assets",
    });
  });

  it("never proxies the canary domain, so a canary cookie cannot loop", () => {
    expect(route("https://code-canary.ras.sh/", "ras_code_web_channel=canary")).toEqual({
      kind: "assets",
    });
  });

  it("serves assets on the canary deployment, which has no router config", () => {
    expect(
      route("https://code-canary.ras.sh/", "ras_code_web_channel=canary", CANARY_DEPLOYMENT),
    ).toEqual({ kind: "assets" });
  });
});

describe("isHostedAppPath", () => {
  it("claims the prefix without its trailing slash, which is a real app URL", () => {
    expect(isHostedAppPath("/app")).toBe(true);
  });

  it("claims everything under the prefix", () => {
    expect(isHostedAppPath("/app/")).toBe(true);
    expect(isHostedAppPath("/app/settings")).toBe(true);
  });

  it("leaves the marketing site's paths alone", () => {
    expect(isHostedAppPath("/")).toBe(false);
    expect(isHostedAppPath("/privacy-policy")).toBe(false);
  });

  it("does not claim a sibling path that merely starts with the same letters", () => {
    expect(isHostedAppPath("/apple")).toBe(false);
  });
});

describe("legacyRedirectLocation", () => {
  it("moves a bare pairing link under the app prefix", () => {
    expect(legacyRedirectLocation(new URL("https://code.ras.sh/pair?host=x"))).toBe(
      "/app/pair?host=x",
    );
  });

  it("moves the CLI callback under the app prefix", () => {
    expect(legacyRedirectLocation(new URL("https://code.ras.sh/connect/callback?code=1"))).toBe(
      "/app/connect/callback?code=1",
    );
  });

  it("leaves a request that already carries the prefix alone", () => {
    expect(legacyRedirectLocation(new URL("https://code.ras.sh/app/pair"))).toBeNull();
  });

  it("ignores a marketing path that merely starts with a legacy name", () => {
    expect(legacyRedirectLocation(new URL("https://code.ras.sh/pairing-guide"))).toBeNull();
  });
});

describe("routeRequest legacy entry points", () => {
  it("redirects rather than serving, so the fragment survives the hop", () => {
    expect(route("https://code.ras.sh/connect", null)).toEqual({
      kind: "redirect",
      location: "/app/connect",
    });
  });
});

describe("readChannelCookie", () => {
  it("finds the channel alongside other cookies", () => {
    expect(readChannelCookie("foo=1; ras_code_web_channel=canary; bar=2")).toBe("canary");
  });

  it("ignores a channel value it does not recognize", () => {
    expect(readChannelCookie("ras_code_web_channel=beta")).toBeNull();
  });

  it("ignores a cookie whose name merely ends with the channel name", () => {
    expect(readChannelCookie("other_ras_code_web_channel=canary")).toBeNull();
  });

  it("returns null when the header is absent", () => {
    expect(readChannelCookie(null)).toBeNull();
  });
});

describe("channelCookie", () => {
  it("scopes the cookie to the whole site and keeps it off client scripts", () => {
    expect(channelCookie("canary")).toBe(
      "ras_code_web_channel=canary; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax",
    );
  });
});

describe("proxyUrl", () => {
  it("preserves the path and query against the upstream origin", () => {
    expect(
      proxyUrl(new URL("https://code.ras.sh/app/threads/1?tab=diff"), "https://code-canary.ras.sh"),
    ).toBe("https://code-canary.ras.sh/app/threads/1?tab=diff");
  });
});

describe("asset serving", () => {
  const shellBody = "<!doctype html>";
  const makeEnv = (files: Record<string, string>) => ({
    ASSETS: {
      fetch: (request: Request) => {
        const path = new URL(request.url).pathname;
        return Promise.resolve(
          path in files
            ? new Response(files[path], { status: 200 })
            : new Response("not found", { status: 404 }),
        );
      },
    },
  });

  const fetchPath = (files: Record<string, string>, path: string) =>
    worker.fetch(new Request(`https://code.ras.sh${path}`), makeEnv(files) as never);

  it("serves a real file under the prefix instead of the shell", async () => {
    const response = await fetchPath(
      { "/app/index.html": shellBody, "/app/assets/main.js": "console.log(1)" },
      "/app/assets/main.js",
    );
    expect(await response.text()).toBe("console.log(1)");
  });

  it("falls back to the shell for a client-side route", async () => {
    const response = await fetchPath({ "/app/index.html": shellBody }, "/app/settings");
    expect(await response.text()).toBe(shellBody);
  });

  it("does not hand the shell to a path outside the app", async () => {
    const response = await fetchPath({ "/app/index.html": shellBody }, "/somewhere-else");
    expect(response.status).toBe(404);
  });
});
