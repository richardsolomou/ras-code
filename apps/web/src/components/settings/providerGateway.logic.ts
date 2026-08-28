import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderListRemoteModelsErrorReason,
} from "@ras-code/contracts";

export const ANTHROPIC_BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL";
export const ANTHROPIC_AUTH_TOKEN_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

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
 * Build the instance envelope for the preset.
 *
 * `homePath` is deliberately left unset: sharing the primary Claude
 * instance's config directory is what lets this instance resume a thread
 * the primary started, which is the whole point of using it as a fallback.
 *
 * `ANTHROPIC_API_KEY` is written as an explicit empty value so a key
 * exported in the user's shell cannot outrank the gateway token.
 */
export function buildPostHogGatewayInstance(input: {
  readonly gatewayKey: string;
  readonly displayName?: string;
}): ProviderInstanceConfig {
  const environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
    {
      name: ANTHROPIC_BASE_URL_VARIABLE,
      value: POSTHOG_GATEWAY_PRESET.baseUrl,
      sensitive: false,
    },
    {
      name: ANTHROPIC_AUTH_TOKEN_VARIABLE,
      value: input.gatewayKey.trim(),
      sensitive: true,
    },
    { name: ANTHROPIC_API_KEY_VARIABLE, value: "", sensitive: false },
  ];
  return {
    driver: POSTHOG_GATEWAY_PRESET.driver,
    displayName: (input.displayName?.trim() || POSTHOG_GATEWAY_PRESET.label) as string,
    accentColor: POSTHOG_GATEWAY_PRESET.accentColor,
    enabled: true,
    environment,
  };
}

function readEnvironmentValue(
  instance: Pick<ProviderInstanceConfig, "environment">,
  name: string,
): string {
  return (
    (instance.environment ?? []).find((variable) => variable.name === name)?.value.trim() ?? ""
  );
}

/**
 * True when the instance is a Claude-driver instance pointed at a gateway,
 * which is the condition for offering the remote-model refresh action.
 */
export function instanceUsesAnthropicGateway(instance: ProviderInstanceConfig): boolean {
  if (String(instance.driver) !== String(CLAUDE_DRIVER)) return false;
  return readEnvironmentValue(instance, ANTHROPIC_BASE_URL_VARIABLE).length > 0;
}

/**
 * Append gateway-reported model ids to the instance's saved custom models,
 * preserving existing entries and their order.
 */
export function mergeRemoteModelsIntoCustomModels(
  customModels: ReadonlyArray<string>,
  remoteModels: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<string> {
  const merged = [...customModels];
  const seen = new Set(merged);
  for (const model of remoteModels) {
    const id = model.id.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

/**
 * Hide every model the Claude CLI ships so the picker for a gateway
 * instance offers only what the gateway advertises. Built-in slugs stay in
 * the list even when the probe has not run yet, so a later probe does not
 * leak them back in.
 */
export function hiddenModelsForGatewayInstance(
  hiddenModels: ReadonlyArray<string>,
  builtInModelSlugs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const next = [...hiddenModels];
  const seen = new Set(next);
  for (const slug of builtInModelSlugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    next.push(slug);
  }
  return next;
}

const REMOTE_MODEL_ERROR_MESSAGES: Record<ProviderListRemoteModelsErrorReason, string> = {
  "instance-not-found": "The server does not know about this provider instance yet.",
  "missing-base-url": `Set ${ANTHROPIC_BASE_URL_VARIABLE} on this instance before listing its models.`,
  "missing-auth": `Set ${ANTHROPIC_AUTH_TOKEN_VARIABLE} on this instance before listing its models.`,
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

export interface ProviderModelPreferences {
  readonly hiddenModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
}

/**
 * The settings patch that adopts a gateway's catalog for one instance: its
 * ids become the instance's custom models, and the driver's own models are
 * hidden so the picker offers only what the gateway serves.
 */
export function gatewayModelSettingsPatch(input: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly instances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly modelPreferences: Readonly<Record<string, ProviderModelPreferences>> | undefined;
  readonly remoteModels: ReadonlyArray<{ readonly id: string }>;
  readonly builtInModelSlugs: ReadonlyArray<string>;
}) {
  const existingCustomModels = readCustomModels(input.instance.config);
  const customModels = mergeRemoteModelsIntoCustomModels(existingCustomModels, input.remoteModels);
  const preferences = input.modelPreferences?.[String(input.instanceId)];
  return {
    providerInstances: {
      ...input.instances,
      [input.instanceId]: {
        ...input.instance,
        config: {
          ...(typeof input.instance.config === "object" && input.instance.config !== null
            ? (input.instance.config as Record<string, unknown>)
            : {}),
          customModels: [...customModels],
        },
      },
    },
    providerModelPreferences: {
      ...input.modelPreferences,
      [input.instanceId]: {
        hiddenModels: [
          ...hiddenModelsForGatewayInstance(
            preferences?.hiddenModels ?? [],
            input.builtInModelSlugs,
          ),
        ],
        modelOrder: [...(preferences?.modelOrder ?? [])],
      },
    },
  };
}

function readCustomModels(config: unknown): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>).customModels;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
