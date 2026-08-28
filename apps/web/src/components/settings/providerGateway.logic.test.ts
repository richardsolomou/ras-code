import { ProviderDriverKind, ProviderInstanceId } from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ANTHROPIC_API_KEY_VARIABLE,
  ANTHROPIC_AUTH_TOKEN_VARIABLE,
  ANTHROPIC_BASE_URL_VARIABLE,
  buildPostHogGatewayInstance,
  describeRemoteModelsError,
  gatewayModelSettingsPatch,
  instanceUsesGateway,
  mergeRemoteModelsIntoCustomModels,
  POSTHOG_GATEWAY_PRESET,
} from "./providerGateway.logic";

const gatewayInstance = () => buildPostHogGatewayInstance({ gatewayKey: "  phs_secret  " });

describe("buildPostHogGatewayInstance", () => {
  it("stores the gateway key as a sensitive variable so it never lands in settings", () => {
    const token = gatewayInstance().environment?.find(
      (variable) => variable.name === ANTHROPIC_AUTH_TOKEN_VARIABLE,
    );
    expect(token).toEqual({
      name: ANTHROPIC_AUTH_TOKEN_VARIABLE,
      value: "phs_secret",
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

describe("instanceUsesGateway", () => {
  it("recognises a Claude instance with a base URL", () => {
    expect(instanceUsesGateway(gatewayInstance())).toBe(true);
  });

  it("rejects an instance with no base URL", () => {
    expect(instanceUsesGateway({ driver: ProviderDriverKind.make("claudeAgent") })).toBe(false);
  });

  it("recognises a Codex instance pointed at the gateway", () => {
    expect(
      instanceUsesGateway({
        driver: ProviderDriverKind.make("codex"),
        environment: [
          { name: "RAS_GATEWAY_BASE_URL", value: "https://example.test", sensitive: false },
        ],
      }),
    ).toBe(true);
  });
});

describe("mergeRemoteModelsIntoCustomModels", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const codexDriver = ProviderDriverKind.make("codex");
  const catalog = [
    { id: "claude-sonnet-4-6" },
    { id: "gpt-5.4" },
    { id: "zai-org/glm-5.2" },
    { id: "moonshotai/kimi-k3" },
  ];

  it("appends new ids after the ones already saved", () => {
    expect(
      mergeRemoteModelsIntoCustomModels(
        ["kept"],
        [{ id: "claude-a" }, { id: "claude-b" }],
        claudeDriver,
      ),
    ).toEqual(["kept", "claude-a", "claude-b"]);
  });

  it("keeps only Claude ids for a Claude instance, which speaks Anthropic Messages", () => {
    expect(mergeRemoteModelsIntoCustomModels([], catalog, claudeDriver)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("drops Claude ids for a Codex instance, which the gateway refuses on the Responses shape", () => {
    expect(mergeRemoteModelsIntoCustomModels([], catalog, codexDriver)).toEqual([
      "gpt-5.4",
      "zai-org/glm-5.2",
      "moonshotai/kimi-k3",
    ]);
  });

  it("keeps the whole catalog for a driver with no known gateway shape", () => {
    expect(
      mergeRemoteModelsIntoCustomModels([], catalog, ProviderDriverKind.make("opencode")).length,
    ).toBe(catalog.length);
  });

  it("drops ids the instance already has", () => {
    expect(mergeRemoteModelsIntoCustomModels(["kept"], [{ id: "kept" }], claudeDriver)).toEqual([
      "kept",
    ]);
  });

  it("drops duplicates within one gateway response", () => {
    expect(
      mergeRemoteModelsIntoCustomModels([], [{ id: "claude-a" }, { id: "claude-a" }], claudeDriver),
    ).toEqual(["claude-a"]);
  });

  it("ignores blank ids", () => {
    expect(mergeRemoteModelsIntoCustomModels([], [{ id: "  " }], claudeDriver)).toEqual([]);
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
      "RAS_GATEWAY_BASE_URL",
    );
  });

  it("falls back to a generic message for an unrecognised failure", () => {
    expect(describeRemoteModelsError(new Error("boom"))).toBe(
      "The model list could not be loaded.",
    );
  });
});
