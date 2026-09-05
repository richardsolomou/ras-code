import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPostHogGatewayEnvironment,
  describeRemoteModelsError,
  instanceUsesGateway,
  mergeRemoteModelsIntoCustomModels,
  POSTHOG_GATEWAY_DRIVER,
  RAS_GATEWAY_KEY_VARIABLE,
} from "./providerGateway.logic";

describe("buildPostHogGatewayEnvironment", () => {
  it("stores the gateway key as a sensitive variable so it never lands in settings", () => {
    expect(buildPostHogGatewayEnvironment("  phs_secret  ")).toEqual([
      { name: RAS_GATEWAY_KEY_VARIABLE, value: "phs_secret", sensitive: true },
    ]);
  });
});

describe("instanceUsesGateway", () => {
  it("recognises a Claude instance pointed at a gateway origin", () => {
    expect(
      instanceUsesGateway({
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [
          {
            name: "ANTHROPIC_BASE_URL",
            value: "https://ai-gateway.us.posthog.com",
            sensitive: false,
          },
        ],
      }),
    ).toBe(true);
  });

  it("excludes the composite driver, which reads its own catalog", () => {
    expect(
      instanceUsesGateway({
        driver: POSTHOG_GATEWAY_DRIVER,
        environment: [
          { name: "RAS_GATEWAY_BASE_URL", value: "https://example.test", sensitive: false },
        ],
      }),
    ).toBe(false);
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
