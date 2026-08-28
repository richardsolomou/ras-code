/**
 * PostHog AI Gateway plumbing shared by the server and the clients.
 *
 * The gateway is one origin serving two request shapes. Anthropic-owned
 * models are reachable only on `POST /v1/messages`; everything else — the
 * open-weight SKUs and the OpenAI catalog — is reachable on Chat Completions
 * and Responses. The router refuses `claude-*` on the OpenAI shapes, so a
 * harness that speaks one wire protocol can only ever be offered the half of
 * the catalog that matches it. `gatewayModelShape` is that split.
 *
 * @module posthogGateway
 */

export const POSTHOG_GATEWAY_BASE_URL = "https://ai-gateway.us.posthog.com";

/** Codex's `model_providers.<id>` key. Built-in ids cannot be overridden, so this is not `openai`. */
export const POSTHOG_GATEWAY_CODEX_PROVIDER_ID = "posthog";

export const RAS_GATEWAY_BASE_URL_VARIABLE = "RAS_GATEWAY_BASE_URL";
export const RAS_GATEWAY_KEY_VARIABLE = "RAS_GATEWAY_KEY";
export const ANTHROPIC_BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL";
export const ANTHROPIC_AUTH_TOKEN_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_API_KEY_VARIABLE = "ANTHROPIC_API_KEY";
export const OPENAI_BASE_URL_VARIABLE = "OPENAI_BASE_URL";
export const OPENAI_API_KEY_VARIABLE = "OPENAI_API_KEY";

/**
 * Where an instance's gateway origin may be written, most specific first.
 * The driver-neutral name wins so one instance can carry both a Claude and a
 * Codex harness without either vendor's variable deciding for it.
 */
export const GATEWAY_BASE_URL_VARIABLES = [
  RAS_GATEWAY_BASE_URL_VARIABLE,
  ANTHROPIC_BASE_URL_VARIABLE,
  OPENAI_BASE_URL_VARIABLE,
] as const;

/** Where an instance's gateway key may be written, most specific first. */
export const GATEWAY_KEY_VARIABLES = [
  RAS_GATEWAY_KEY_VARIABLE,
  ANTHROPIC_AUTH_TOKEN_VARIABLE,
  ANTHROPIC_API_KEY_VARIABLE,
  OPENAI_API_KEY_VARIABLE,
] as const;

export interface GatewayEnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

const readVariable = (
  environment: ReadonlyArray<GatewayEnvironmentVariable>,
  names: ReadonlyArray<string>,
): GatewayEnvironmentVariable | undefined => {
  for (const name of names) {
    const value = environment.find((variable) => variable.name === name)?.value.trim();
    if (value !== undefined && value.length > 0) {
      return { name, value };
    }
  }
  return undefined;
};

/** The gateway origin an instance is pointed at, or `""` when it is not pointed at one. */
export function gatewayBaseUrl(
  environment: ReadonlyArray<GatewayEnvironmentVariable> | undefined,
): string {
  return readVariable(environment ?? [], GATEWAY_BASE_URL_VARIABLES)?.value ?? "";
}

/**
 * The gateway key an instance carries, with the variable it came from — the
 * caller needs the name to decide between a bearer token and an `x-api-key`
 * header.
 */
export function gatewayKey(
  environment: ReadonlyArray<GatewayEnvironmentVariable> | undefined,
): GatewayEnvironmentVariable | undefined {
  return readVariable(environment ?? [], GATEWAY_KEY_VARIABLES);
}

export type GatewayModelShape = "anthropic" | "openai";

/**
 * The wire shape the gateway will serve a catalog id on.
 *
 * Claude ids are Anthropic Messages only. The gateway does carry an
 * OpenAI→Anthropic translation, but it is wired for Chat Completions and is
 * reachable only through the `posthog/<tier>` category route, never for a
 * concrete `claude-*` id and never on Responses — so a Responses-speaking
 * harness must not be offered them.
 *
 * Ids arrive either bare (`claude-sonnet-4-5`) or namespaced
 * (`anthropic/claude-sonnet-4-5`, `zai-org/glm-5.2`), so the vendor check
 * runs on the last segment.
 */
export function gatewayModelShape(id: string): GatewayModelShape {
  const slug = id.trim();
  const bare = slug.slice(slug.lastIndexOf("/") + 1);
  return bare.startsWith("claude-") ? "anthropic" : "openai";
}

export interface CodexLaunchArgs {
  /** Exactly the tokens appended to `codex app-server`. */
  readonly argv: ReadonlyArray<string>;
  /** The same tokens as one `launchArgs` settings string. */
  readonly launchArgs: string;
}

/**
 * The Codex config overrides that point `codex app-server` at the gateway.
 *
 * Codex parses each `-c key=value` value as TOML and falls back to the raw
 * string when that fails, so bare values are already string literals; the
 * settings string only quotes the value that contains a space, which the
 * launch-args tokeniser strips back off.
 */
export function posthogGatewayCodexLaunchArgs(
  envKeyName: string = RAS_GATEWAY_KEY_VARIABLE,
  baseUrl: string = POSTHOG_GATEWAY_BASE_URL,
): CodexLaunchArgs {
  const id = POSTHOG_GATEWAY_CODEX_PROVIDER_ID;
  // Codex appends `/responses` to base_url, and only the `/v1`-prefixed
  // route is guaranteed to exist for the rest of the gateway's endpoints.
  const providerBaseUrl = `${baseUrl.replace(/\/+$/, "")}/v1`;
  const values: ReadonlyArray<string> = [
    `model_provider=${id}`,
    `model_providers.${id}.name=PostHog AI Gateway`,
    `model_providers.${id}.base_url=${providerBaseUrl}`,
    `model_providers.${id}.env_key=${envKeyName}`,
    `model_providers.${id}.wire_api=responses`,
    // The gateway's Responses→Chat bridge accepts `function` tools only, so the
    // tool families Codex would otherwise advertise (web search, multi-agent,
    // connector apps) are switched off for gateway sessions.
    "web_search=disabled",
    "features.multi_agent=false",
    "features.apps=false",
  ];
  return {
    argv: values.flatMap((value) => ["-c", value]),
    launchArgs: values.map((value) => `-c ${value.includes(" ") ? `'${value}'` : value}`).join(" "),
  };
}
