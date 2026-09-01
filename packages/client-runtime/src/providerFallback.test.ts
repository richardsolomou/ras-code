import { ProviderInstanceId } from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveActiveProviderInstanceId,
  resolveActiveProviderModelSelection,
} from "./providerFallback.ts";

const claudeSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-5",
};

describe("resolveActiveProviderInstanceId", () => {
  it("uses the provider serving the active session", () => {
    expect(
      resolveActiveProviderInstanceId({
        modelSelection: claudeSelection,
        session: { providerInstanceId: ProviderInstanceId.make("posthog_gateway") },
      }),
    ).toBe("posthog_gateway");
  });
});

describe("resolveActiveProviderModelSelection", () => {
  it("matches the selected model to a namespaced fallback slug", () => {
    expect(
      resolveActiveProviderModelSelection(
        {
          modelSelection: claudeSelection,
          session: { providerInstanceId: ProviderInstanceId.make("posthog_gateway") },
        },
        [
          {
            instanceId: ProviderInstanceId.make("posthog_gateway"),
            models: [{ slug: "anthropic/claude-sonnet-4-5" }],
          },
        ],
      ),
    ).toEqual({
      instanceId: ProviderInstanceId.make("posthog_gateway"),
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("keeps the original model when the active provider has no match", () => {
    expect(
      resolveActiveProviderModelSelection(
        {
          modelSelection: claudeSelection,
          session: { providerInstanceId: ProviderInstanceId.make("posthog_gateway") },
        },
        [{ instanceId: ProviderInstanceId.make("posthog_gateway"), models: [] }],
      ),
    ).toEqual({
      instanceId: ProviderInstanceId.make("posthog_gateway"),
      model: "claude-sonnet-4-5",
    });
  });
});
