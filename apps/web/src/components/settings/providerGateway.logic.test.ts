import { ProviderDriverKind, ProviderInstanceId } from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ANTHROPIC_API_KEY_VARIABLE,
  ANTHROPIC_AUTH_TOKEN_VARIABLE,
  ANTHROPIC_BASE_URL_VARIABLE,
  buildPostHogGatewayInstance,
  describeRemoteModelsError,
  gatewayModelSettingsPatch,
  instanceUsesAnthropicGateway,
  mergeRemoteModelsIntoCustomModels,
  POSTHOG_GATEWAY_PRESET,
} from "./providerGateway.logic";

const gatewayInstance = () => buildPostHogGatewayInstance({ gatewayKey: "  phx_secret  " });

describe("buildPostHogGatewayInstance", () => {
  it("stores the gateway key as a sensitive variable so it never lands in settings", () => {
    const token = gatewayInstance().environment?.find(
      (variable) => variable.name === ANTHROPIC_AUTH_TOKEN_VARIABLE,
    );
    expect(token).toEqual({
      name: ANTHROPIC_AUTH_TOKEN_VARIABLE,
      value: "phx_secret",
      sensitive: true,
    });
  });

  it("points the instance at the PostHog gateway", () => {
    expect(
      gatewayInstance().environment?.find(
        (variable) => variable.name === ANTHROPIC_BASE_URL_VARIABLE,
      )?.value,
    ).toBe("https://ai-gateway.us.posthog.com");
  });

  it("writes an empty API key so a shell key cannot outrank the gateway token", () => {
    expect(
      gatewayInstance().environment?.find(
        (variable) => variable.name === ANTHROPIC_API_KEY_VARIABLE,
      ),
    ).toEqual({ name: ANTHROPIC_API_KEY_VARIABLE, value: "", sensitive: false });
  });

  it("leaves the Claude config directory unset so a fallback shares the primary's threads", () => {
    expect(gatewayInstance().config).toBeUndefined();
  });

  it("uses the Claude driver", () => {
    expect(String(gatewayInstance().driver)).toBe("claudeAgent");
  });

  it("keeps a caller-supplied display name", () => {
    expect(buildPostHogGatewayInstance({ gatewayKey: "k", displayName: "Work" }).displayName).toBe(
      "Work",
    );
  });
});

describe("instanceUsesAnthropicGateway", () => {
  it("recognises a Claude instance with a base URL", () => {
    expect(instanceUsesAnthropicGateway(gatewayInstance())).toBe(true);
  });

  it("rejects a Claude instance with no base URL", () => {
    expect(instanceUsesAnthropicGateway({ driver: ProviderDriverKind.make("claudeAgent") })).toBe(
      false,
    );
  });

  it("rejects a non-Claude instance even when it sets a base URL", () => {
    expect(
      instanceUsesAnthropicGateway({
        driver: ProviderDriverKind.make("codex"),
        environment: [
          { name: ANTHROPIC_BASE_URL_VARIABLE, value: "https://example.test", sensitive: false },
        ],
      }),
    ).toBe(false);
  });
});

describe("mergeRemoteModelsIntoCustomModels", () => {
  it("appends new ids after the ones already saved", () => {
    expect(
      mergeRemoteModelsIntoCustomModels(["kept"], [{ id: "claude-a" }, { id: "claude-b" }]),
    ).toEqual(["kept", "claude-a", "claude-b"]);
  });

  it("skips catalog ids Claude Code cannot request through the Anthropic shape", () => {
    expect(
      mergeRemoteModelsIntoCustomModels(
        [],
        [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }, { id: "zai-org/glm-5.2" }],
      ),
    ).toEqual(["claude-sonnet-4-6"]);
  });

  it("drops ids the instance already has", () => {
    expect(mergeRemoteModelsIntoCustomModels(["kept"], [{ id: "kept" }])).toEqual(["kept"]);
  });

  it("drops duplicates within one gateway response", () => {
    expect(mergeRemoteModelsIntoCustomModels([], [{ id: "claude-a" }, { id: "claude-a" }])).toEqual(
      ["claude-a"],
    );
  });

  it("ignores blank ids", () => {
    expect(mergeRemoteModelsIntoCustomModels([], [{ id: "  " }])).toEqual([]);
  });
});

describe("gatewayModelSettingsPatch", () => {
  const instanceId = POSTHOG_GATEWAY_PRESET.instanceId;
  const patch = () =>
    gatewayModelSettingsPatch({
      instanceId,
      instance: gatewayInstance(),
      instances: {},
      modelPreferences: undefined,
      remoteModels: [{ id: "claude-sonnet-4-6" }],
      builtInModelSlugs: ["claude-sonnet-4-6", "claude-opus-4-6"],
    });

  it("adopts the gateway ids as the instance's custom models", () => {
    const config = patch().providerInstances[instanceId]?.config as
      | { readonly customModels: ReadonlyArray<string> }
      | undefined;
    expect(config?.customModels).toEqual(["claude-sonnet-4-6"]);
  });

  it("hides the driver's own models so the picker offers only gateway models", () => {
    expect(patch().providerModelPreferences[instanceId]?.hiddenModels).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
  });

  it("leaves other instances untouched", () => {
    const other = ProviderInstanceId.make("codex");
    const result = gatewayModelSettingsPatch({
      instanceId,
      instance: gatewayInstance(),
      instances: { [other]: { driver: ProviderDriverKind.make("codex") } },
      modelPreferences: undefined,
      remoteModels: [],
      builtInModelSlugs: [],
    });
    expect(result.providerInstances[other]).toEqual({
      driver: ProviderDriverKind.make("codex"),
    });
  });
});

describe("describeRemoteModelsError", () => {
  it("explains a missing base URL in plain English", () => {
    expect(describeRemoteModelsError({ reason: "missing-base-url" })).toContain(
      ANTHROPIC_BASE_URL_VARIABLE,
    );
  });

  it("falls back to a generic message for an unrecognised failure", () => {
    expect(describeRemoteModelsError(new Error("boom"))).toBe(
      "The model list could not be loaded.",
    );
  });
});
