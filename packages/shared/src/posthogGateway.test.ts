import { describe, expect, it } from "vite-plus/test";

import { tokenizeCliArgs } from "./cliArgs.ts";
import {
  gatewayBaseUrl,
  gatewayKey,
  gatewayModelShape,
  isPostHogGatewayCrossShapeModelChange,
  posthogGatewayCodexLaunchArgs,
} from "./posthogGateway.ts";

const variable = (name: string, value: string) => ({ name, value });

describe("gatewayBaseUrl", () => {
  it("prefers the driver-neutral variable over a vendor one", () => {
    expect(
      gatewayBaseUrl([
        variable("ANTHROPIC_BASE_URL", "https://anthropic.test"),
        variable("RAS_GATEWAY_BASE_URL", "https://gateway.test"),
      ]),
    ).toBe("https://gateway.test");
  });

  it("falls through to the OpenAI variable", () => {
    expect(gatewayBaseUrl([variable("OPENAI_BASE_URL", "https://openai.test")])).toBe(
      "https://openai.test",
    );
  });

  it("treats a blank value as unset", () => {
    expect(
      gatewayBaseUrl([
        variable("RAS_GATEWAY_BASE_URL", "   "),
        variable("ANTHROPIC_BASE_URL", "https://anthropic.test"),
      ]),
    ).toBe("https://anthropic.test");
  });

  it("reports no origin when the instance carries none", () => {
    expect(gatewayBaseUrl([])).toBe("");
  });
});

describe("gatewayKey", () => {
  it("reports the variable the key came from so the caller can pick a header", () => {
    expect(gatewayKey([variable("ANTHROPIC_API_KEY", "sk-test")])).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "sk-test",
    });
  });

  it("prefers the driver-neutral key", () => {
    expect(
      gatewayKey([
        variable("ANTHROPIC_AUTH_TOKEN", "anthropic"),
        variable("RAS_GATEWAY_KEY", "phs_test"),
      ])?.value,
    ).toBe("phs_test");
  });

  it("reports nothing when no key is set", () => {
    expect(gatewayKey([variable("ANTHROPIC_API_KEY", "")])).toBeUndefined();
  });
});

describe("gatewayModelShape", () => {
  it("keeps a bare Claude id on the Anthropic shape", () => {
    expect(gatewayModelShape("claude-sonnet-4-5")).toBe("anthropic");
  });

  it("keeps a namespaced Claude id on the Anthropic shape", () => {
    expect(gatewayModelShape("anthropic/claude-opus-4-1")).toBe("anthropic");
  });

  it("puts an open-weight id on the OpenAI shape", () => {
    expect(gatewayModelShape("zai-org/glm-5.2")).toBe("openai");
  });

  it("puts an OpenAI id on the OpenAI shape", () => {
    expect(gatewayModelShape("gpt-5.4")).toBe("openai");
  });

  it("does not mistake a vendor named after Claude for an Anthropic model", () => {
    expect(gatewayModelShape("claudette/claudia-1")).toBe("openai");
  });
});

describe("isPostHogGatewayCrossShapeModelChange", () => {
  it("blocks a Claude thread from moving to an open gateway model", () => {
    expect(
      isPostHogGatewayCrossShapeModelChange({
        currentDriver: "claudeAgent",
        currentModel: "claude-opus-4-6",
        nextDriver: "posthogGateway",
        nextModel: "zai-org/glm-5.3-flash",
      }),
    ).toBe(true);
  });

  it("allows a Claude thread to continue on a Claude gateway model", () => {
    expect(
      isPostHogGatewayCrossShapeModelChange({
        currentDriver: "claudeAgent",
        currentModel: "claude-opus-4-6",
        nextDriver: "posthogGateway",
        nextModel: "anthropic/claude-sonnet-4-6",
      }),
    ).toBe(false);
  });

  it("blocks an open gateway session from moving to Claude", () => {
    expect(
      isPostHogGatewayCrossShapeModelChange({
        currentDriver: "posthogGateway",
        currentModel: "zai-org/glm-5.3-flash",
        nextDriver: "claudeAgent",
        nextModel: "claude-opus-4-6",
      }),
    ).toBe(true);
  });
});

describe("posthogGatewayCodexLaunchArgs", () => {
  it("produces the argv codex app-server expects", () => {
    expect(posthogGatewayCodexLaunchArgs().argv).toEqual([
      "-c",
      "model_provider=posthog",
      "-c",
      "model_providers.posthog.name=PostHog AI Gateway",
      "-c",
      "model_providers.posthog.base_url=https://ai-gateway.us.posthog.com/v1",
      "-c",
      "model_providers.posthog.env_key=RAS_GATEWAY_KEY",
      "-c",
      "model_providers.posthog.wire_api=responses",
      "-c",
      "web_search=disabled",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.apps=false",
    ]);
  });

  it("survives the launch-args tokeniser unchanged", () => {
    const { argv, launchArgs } = posthogGatewayCodexLaunchArgs();
    expect(tokenizeCliArgs(launchArgs)).toEqual(argv);
  });

  it("names the environment variable codex reads the key from", () => {
    expect(posthogGatewayCodexLaunchArgs("MY_KEY").argv).toContain(
      "model_providers.posthog.env_key=MY_KEY",
    );
  });

  it("appends the versioned path a base URL is missing", () => {
    expect(posthogGatewayCodexLaunchArgs("K", "https://gateway.test/").argv).toContain(
      "model_providers.posthog.base_url=https://gateway.test/v1",
    );
  });
});
