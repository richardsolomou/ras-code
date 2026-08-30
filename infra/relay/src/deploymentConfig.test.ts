import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  relayEndpointNamespaceForStage,
  relayOwnsGatewayZone,
  RelayPublicDomainLabelTooLongError,
  relayPublicDomainForStage,
  relayResourceNameForStage,
  relayStageSlug,
  rasRelayEndpointDigestInput,
  rasRelayEndpointForId,
  rasRelayEndpointId,
} from "./deploymentConfig.ts";

const isRelayPublicDomainLabelTooLongError = Schema.is(RelayPublicDomainLabelTooLongError);

describe("relayStageSlug", () => {
  it("matches Alchemy physical-name sanitization for default developer stages", () => {
    expect(relayStageSlug("dev_julius")).toBe("dev-julius");
  });
});

describe("relayPublicDomainForStage", () => {
  it("uses the canonical relay hostname for production", () => {
    expect(relayPublicDomainForStage("prod", ".example.com.")).toBe("code-relay.example.com");
  });

  it("isolates personal stages below the imported zone", () => {
    expect(relayPublicDomainForStage("dev_julius", "example.com")).toBe(
      "code-relay-dev-julius.example.com",
    );
  });

  it("reports the stage and derived DNS label when the label is too long", () => {
    const stage = `dev_${"x".repeat(60)}`;
    let error: unknown;

    try {
      relayPublicDomainForStage(stage, "example.com");
    } catch (cause) {
      error = cause;
    }

    if (!isRelayPublicDomainLabelTooLongError(error)) {
      throw error;
    }
    expect(error).toMatchObject({
      stage,
      label: `code-relay-dev-${"x".repeat(60)}`,
      maxLength: 63,
    });
    expect(error.message).toBe(
      `Relay stage '${stage}' produces custom domain label 'code-relay-dev-${"x".repeat(60)}' (75 characters), exceeding the DNS label limit of 63.`,
    );
  });
});

describe("relayOwnsGatewayZone", () => {
  it("keeps the shared Cloudflare zone owned by production", () => {
    expect(relayOwnsGatewayZone("prod")).toBe(true);
    expect(relayOwnsGatewayZone("dev_julius")).toBe(false);
  });
});

describe("relayResourceNameForStage", () => {
  it("isolates production and personal stages", () => {
    expect(relayResourceNameForStage("ras-code-relay-traces", "prod")).toBe(
      "ras-code-relay-traces-prod",
    );
    expect(relayResourceNameForStage("ras-code-relay-traces", "dev_julius")).toBe(
      "ras-code-relay-traces-dev-julius",
    );
  });
});

describe("relayEndpointNamespaceForStage", () => {
  it("uses a branded production namespace when configured", () => {
    expect(relayEndpointNamespaceForStage("prod", "code")).toBe("code");
  });

  it("falls back to the deployment stage", () => {
    expect(relayEndpointNamespaceForStage("dev_julius")).toBe("dev-julius");
  });
});

describe("managed endpoint names", () => {
  it("publishes environment-scoped RAS relay endpoints through the gateway", () => {
    expect(rasRelayEndpointDigestInput("prod", "env_123")).toBe("prod:ras-relay:env_123");
    expect(rasRelayEndpointId("ABCDEF0123456789ABCDEF0123456789")).toBe("abcdef0123456789");
    expect(rasRelayEndpointForId("code-tunnels.ras.sh", "abcdef0123456789")).toEqual({
      httpBaseUrl: "https://code-tunnels.ras.sh/e/abcdef0123456789/",
      wsBaseUrl: "wss://code-tunnels.ras.sh/e/abcdef0123456789/ws",
      providerKind: "ras_relay",
    });
  });
});
