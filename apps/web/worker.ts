/**
 * Entry point for the hosted web app's Cloudflare Worker.
 *
 * Both release channels deploy this same module. The canary deployment only
 * ever serves its own domain, so the router branch below is inert there; the
 * latest deployment additionally owns the router domain users open, and decides
 * per request whether to serve its own assets or hand off to canary.
 */

const CHANNEL_COOKIE = "ras_code_web_channel";
const CHANNEL_PATH = "/__ras-code/channel";
const CHANNEL_COOKIE_MAX_AGE = 31_536_000;

export type Channel = "latest" | "canary";

export interface WebRouterConfig {
  /** Host users open. Absent on the canary deployment. */
  readonly routerHost?: string | undefined;
  /** Origin serving the canary channel, e.g. `https://code-canary.ras.sh`. */
  readonly canaryOrigin?: string | undefined;
}

export type RouterAction =
  | { readonly kind: "set-channel"; readonly channel: Channel }
  | { readonly kind: "proxy"; readonly origin: string }
  | { readonly kind: "assets" };

export function channelCookie(channel: Channel): string {
  return [
    `${CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    `Max-Age=${CHANNEL_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function readChannelCookie(cookieHeader: string | null | undefined): Channel | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CHANNEL_COOKIE) {
      const value = rest.join("=");
      return value === "canary" || value === "latest" ? value : null;
    }
  }
  return null;
}

/**
 * Decides what to do with a request, mirroring the route table the hosted app
 * used before it moved to Workers. Opting into a channel is only meaningful on
 * the router host, because the cookie it sets is scoped to that host.
 */
export function routeRequest(
  url: URL,
  cookieHeader: string | null | undefined,
  config: WebRouterConfig,
): RouterAction {
  if (url.pathname === CHANNEL_PATH) {
    return {
      kind: "set-channel",
      channel: url.searchParams.get("channel") === "canary" ? "canary" : "latest",
    };
  }

  const isRouterHost = Boolean(config.routerHost) && url.hostname === config.routerHost;
  if (isRouterHost && config.canaryOrigin && readChannelCookie(cookieHeader) === "canary") {
    return { kind: "proxy", origin: config.canaryOrigin };
  }

  return { kind: "assets" };
}

/** Rebuilds the upstream URL for a proxied request, preserving path and query. */
export function proxyUrl(url: URL, origin: string): string {
  const upstream = new URL(origin);
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  return upstream.toString();
}

interface WorkerEnv extends WebRouterConfig {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  readonly RAS_CODE_WEB_ROUTER_HOST?: string;
  readonly RAS_CODE_WEB_CANARY_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const action = routeRequest(url, request.headers.get("cookie"), {
      routerHost: env.RAS_CODE_WEB_ROUTER_HOST,
      canaryOrigin: env.RAS_CODE_WEB_CANARY_ORIGIN,
    });

    switch (action.kind) {
      case "set-channel":
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": channelCookie(action.channel),
          },
        });
      case "proxy":
        return fetch(new Request(proxyUrl(url, action.origin), request));
      case "assets":
        return env.ASSETS.fetch(request);
    }
  },
};
