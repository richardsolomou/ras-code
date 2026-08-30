import { readHashParams } from "./remote.ts";

const CONNECT_AUTH_STATE_PARAM = "state";
const CONNECT_AUTH_CHALLENGE_PARAM = "challenge";
const CONNECT_AUTH_PORT_PARAM = "port";
const CONNECT_AUTH_CODE_SEPARATOR = ".";
const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";

// Resolved against the hosted app URL, so they carry no leading slash: an
// absolute path would discard that URL's own path prefix.
const CONNECT_AUTHORIZE_PATH = "connect";
const CONNECT_CALLBACK_PATH = "connect/callback";

/**
 * Path prefix the hosted deployment serves the app under, so the marketing
 * site can own the origin root. The hosted build bakes this in as its Vite
 * base; other deployments (desktop, a bundled server) serve from the root.
 */
export const HOSTED_APP_BASE_PATH = "/app/";

/**
 * The RAS-hosted deployment. The web bundle compares its own origin against
 * this to decide whether it is that deployment, so it must stay a fixed origin:
 * deriving it from the current origin makes every build think it is hosted.
 * Builds for another deployment override it with `VITE_HOSTED_APP_URL`.
 */
export const DEFAULT_HOSTED_APP_URL = `https://code.ras.sh${HOSTED_APP_BASE_PATH}`;

/**
 * Resolves a path against a hosted app URL that may carry a path prefix.
 * `new URL("/pair", "https://host/app")` drops the prefix, so every hosted
 * link builds from a base normalized to end in a slash.
 */
export function hostedAppUrlFor(hostedAppUrl: string, path: string): URL {
  const base = new URL(hostedAppUrl);
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  return new URL(path, base);
}

/**
 * Requested at authorize time by the hosted page and honored by the CLI's
 * token exchange; keep both sides on this single definition.
 */
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email"] as const;

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
  /**
   * Present when a loopback CLI initiated the request: the hosted /connect
   * page then asks Clerk to redirect the authorization code straight to
   * `http://127.0.0.1:<port>/callback` instead of the hosted callback page.
   */
  readonly loopbackPort?: number;
}

/**
 * The URL the CLI prints for the user to open in a browser. `state` and
 * `code_challenge` ride the fragment so they never reach the hosted app's
 * server or CDN logs; neither is a secret.
 *
 * Both CLI flows route through the hosted /connect page rather than hitting
 * Clerk's /oauth/authorize directly: a signed-out browser sent straight to
 * /oauth/authorize goes through Clerk's sign-in redirect, which does not
 * reliably preserve the authorize query parameters (state, response_type,
 * code_challenge). The hosted page waits for a Clerk session first, then
 * forwards the request with the parameters intact.
 */
export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort?: number;
}): string {
  const url = hostedAppUrlFor(input.hostedAppUrl, CONNECT_AUTHORIZE_PATH);
  url.hash = new URLSearchParams([
    [CONNECT_AUTH_STATE_PARAM, input.state],
    [CONNECT_AUTH_CHALLENGE_PARAM, input.challenge],
    ...(input.loopbackPort === undefined
      ? []
      : [[CONNECT_AUTH_PORT_PARAM, String(input.loopbackPort)] as [string, string]]),
  ]).toString();
  return url.toString();
}

export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequest | null {
  const params = readHashParams(url);
  const state = params.get(CONNECT_AUTH_STATE_PARAM)?.trim() ?? "";
  const challenge = params.get(CONNECT_AUTH_CHALLENGE_PARAM)?.trim() ?? "";
  if (!state || !challenge) {
    return null;
  }
  const port = params.get(CONNECT_AUTH_PORT_PARAM);
  if (port === null) {
    return { state, challenge };
  }
  // A present-but-invalid port means the link was corrupted; reject the whole
  // request rather than silently downgrading a loopback flow to the
  // out-of-band one, which would strand the waiting CLI.
  const loopbackPort = parseLoopbackPort(port.trim());
  if (loopbackPort === null) {
    return null;
  }
  return { state, challenge, loopbackPort };
}

function parseLoopbackPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Redirect URI for the CLI's local callback listener. Must stay in sync with
 * the redirect URI registered on the Clerk CLI OAuth application.
 */
export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
}

export function connectCallbackUrl(hostedAppUrl: string): string {
  return hostedAppUrlFor(hostedAppUrl, CONNECT_CALLBACK_PATH).toString();
}

export function buildConnectClerkAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface ConnectAuthCode {
  readonly code: string;
  readonly state: string;
}

/**
 * The single blob the hosted callback page displays and the CLI accepts.
 * Bundling `state` with the authorization code lets the CLI keep the loopback
 * flow's CSRF check without any backend: it verifies the returned state
 * matches the one it generated. Clerk authorization codes and the CLI's
 * base64url states never contain ".".
 */
export function encodeConnectAuthCode(input: ConnectAuthCode): string {
  return `${input.code}${CONNECT_AUTH_CODE_SEPARATOR}${input.state}`;
}

/**
 * Validates an out-of-band authorization code against the state of the request this process
 * generated. Returns the parsed code or a user-facing error message; both
 * the prompt's live validation and the authoritative post-prompt check go
 * through here so they cannot drift.
 */
export function checkConnectAuthCode(
  blob: string,
  expectedState: string,
): ConnectAuthCode | string {
  const parsed = parseConnectAuthCode(blob);
  if (parsed === null) {
    return "That does not look like a RAS Connect code. Copy the full code.";
  }
  if (parsed.state !== expectedState) {
    return "That code belongs to a different connect request. Open the URL above and try again.";
  }
  return parsed;
}

export function parseConnectAuthCode(blob: string): ConnectAuthCode | null {
  const trimmed = blob.trim();
  const separatorIndex = trimmed.lastIndexOf(CONNECT_AUTH_CODE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }
  const code = trimmed.slice(0, separatorIndex);
  const state = trimmed.slice(separatorIndex + 1);
  return { code, state };
}
