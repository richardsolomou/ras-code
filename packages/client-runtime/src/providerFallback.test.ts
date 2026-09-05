import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fallbackInstanceIsMetered,
  fallbackInstanceLabel,
  resolveActiveProviderInstanceId,
  resolveActiveProviderModelSelection,
} from "./providerFallback.ts";

const codexPersonal = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex Personal",
};
const gateway = {
  instanceId: ProviderInstanceId.make("posthog_gateway"),
  driver: ProviderDriverKind.make("posthogGateway"),
};

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

describe("fallbackInstanceLabel", () => {
  it("falls back to the driver name when the instance has no display name", () => {
    expect(fallbackInstanceLabel([codexPersonal, gateway], "posthog_gateway")).toBe(
      "PostHog AI Gateway",
    );
  });

  it("names an unknown instance by its id", () => {
    expect(fallbackInstanceLabel([codexPersonal], "codex_work")).toBe("codex_work");
  });
});

describe("fallbackInstanceIsMetered", () => {
  it("reads a second subscription as already paid for", () => {
    expect(fallbackInstanceIsMetered([codexPersonal, gateway], "codex_personal")).toBe(false);
  });

  it("reads the gateway as metered", () => {
    expect(fallbackInstanceIsMetered([codexPersonal, gateway], "posthog_gateway")).toBe(true);
  });
});
