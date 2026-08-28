import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderListRemoteModelsErrorReason,
} from "@ras-code/contracts";
import {
  gatewayBaseUrl,
  gatewayModelShape,
  GATEWAY_BASE_URL_VARIABLES,
  GATEWAY_KEY_VARIABLES,
  RAS_GATEWAY_KEY_VARIABLE,
  type GatewayModelShape,
} from "@ras-code/shared/posthogGateway";

export { RAS_GATEWAY_KEY_VARIABLE } from "@ras-code/shared/posthogGateway";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
export const POSTHOG_GATEWAY_DRIVER = ProviderDriverKind.make("posthogGateway");

/** Suggested id and accent for a new PostHog AI Gateway instance. */
export const POSTHOG_GATEWAY_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("posthog_gateway");
export const POSTHOG_GATEWAY_ACCENT_COLOR = "#ea580c";

/**
 * Instance id the retired Claude-driver preset created. Instances that still
 * carry it keep working as plain Claude instances; the card points the user at
 * the real driver rather than migrating anything behind their back.
 */
export const LEGACY_POSTHOG_GATEWAY_INSTANCE_ID = "claude_posthog_gateway";

/**
 * The "PostHog AI Gateway" preset offered beside the raw drivers in the
 * add-provider wizard. It is a Claude instance pointed at an
 * Anthropic-shaped proxy, so everything here is ordinary instance config —
 * the preset only saves the user from typing it.
 */
export const POSTHOG_GATEWAY_PRESET = {
  driver: CLAUDE_DRIVER,
  instanceId: ProviderInstanceId.make("claude_posthog_gateway"),
  label: "PostHog AI Gateway",
  accentColor: "#ea580c",
  baseUrl: "https://ai-gateway.us.posthog.com",
} as const;

/**
 * The gateway key as this driver's instance environment stores it. The base
 * URL is config, not environment: the driver hands each harness the vendor
 * variable it expects.
 */
export function buildPostHogGatewayEnvironment(
  gatewayKey: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return [{ name: RAS_GATEWAY_KEY_VARIABLE, value: gatewayKey.trim(), sensitive: true }];
}

/**
 * True when the instance carries a gateway origin under any of the names the
 * server will look for, which is the condition for offering the remote-model
 * refresh action. The driver does not matter: a Codex instance pointed at the
 * gateway needs the same catalog lookup a Claude one does.
 */
export function instanceUsesGateway(instance: ProviderInstanceConfig): boolean {
  // The composite driver reads its catalog from the gateway itself, so its
  // model list is never something the user has to import by hand.
  if (String(instance.driver) === String(POSTHOG_GATEWAY_DRIVER)) return false;
  return gatewayBaseUrl(instance.environment).length > 0;
}

/**
 * The wire shape a driver's harness speaks to the gateway, or `undefined` for
 * a driver that does not talk to it — those keep the whole catalog, since
 * only the harness itself can say what it can request.
 */
export function driverGatewayShape(
  driver: ProviderInstanceConfig["driver"],
): GatewayModelShape | undefined {
  if (String(driver) === String(CLAUDE_DRIVER)) return "anthropic";
  if (String(driver) === String(CODEX_DRIVER)) return "openai";
  return undefined;
}

/**
 * Append the gateway-reported ids the instance's harness can actually
 * request to its saved custom models, preserving existing entries and their
 * order. Claude Code speaks Anthropic Messages, so it keeps only `claude-*`;
 * Codex speaks Responses, on which the gateway refuses those same ids.
 */
export function mergeRemoteModelsIntoCustomModels(
  customModels: ReadonlyArray<string>,
  remoteModels: ReadonlyArray<{ readonly id: string }>,
  driver: ProviderInstanceConfig["driver"],
): ReadonlyArray<string> {
  const shape = driverGatewayShape(driver);
  const merged = [...customModels];
  const seen = new Set(merged);
  for (const model of remoteModels) {
    const id = model.id.trim();
    if (id.length === 0 || seen.has(id)) continue;
    if (shape !== undefined && gatewayModelShape(id) !== shape) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

const REMOTE_MODEL_ERROR_MESSAGES: Record<ProviderListRemoteModelsErrorReason, string> = {
  "instance-not-found": "The server does not know about this provider instance yet.",
  "missing-base-url": `Set ${GATEWAY_BASE_URL_VARIABLES[0]} on this instance before listing its models.`,
  "missing-auth": `Set ${GATEWAY_KEY_VARIABLES[0]} on this instance before listing its models.`,
  "request-failed": "The gateway did not answer. Check the base URL and the key.",
  "invalid-response": "The gateway answered with something that is not a model list.",
};

export function describeRemoteModelsError(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? (error as { readonly reason: unknown }).reason
      : undefined;
  if (typeof reason === "string" && reason in REMOTE_MODEL_ERROR_MESSAGES) {
    return REMOTE_MODEL_ERROR_MESSAGES[reason as ProviderListRemoteModelsErrorReason];
  }
  return "The model list could not be loaded.";
}
