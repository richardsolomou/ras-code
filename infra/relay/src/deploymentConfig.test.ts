import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointRequestOrigin,
  managedEndpointGatewayTargetHostname,
  managedEndpointHostname,
  managedEndpointNamespaceForStage,
  isManagedEndpointHostname,
  managedEndpointTunnelName,
  relayOwnsManagedEndpointZone,
  RelayPublicDomainLabelTooLongError,
  relayPublicDomainForStage,
  relayResourceNameForStage,
  relayStageSlug,
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

describe("relayOwnsManagedEndpointZone", () => {
  it("keeps the shared Cloudflare zone owned by production", () => {
    expect(relayOwnsManagedEndpointZone("prod")).toBe(true);
    expect(relayOwnsManagedEndpointZone("dev_julius")).toBe(false);
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

describe("managedEndpointNamespaceForStage", () => {
  it("uses a branded production namespace when configured", () => {
    expect(managedEndpointNamespaceForStage("prod", "code")).toBe("code");
  });

  it("falls back to the deployment stage", () => {
    expect(managedEndpointNamespaceForStage("dev_julius")).toBe("dev-julius");
  });
});

describe("managed endpoint names", () => {
  it("uses the stage slug and a stable stage-scoped digest suffix", () => {
    const hash = "ABCDEF0123456789ABCDEF0123456789";

    expect(managedEndpointDigestInput("dev_julius", "user_123", "env_123")).toBe(
      "dev_julius:user_123:env_123",
    );
    expect(managedEndpointHostname("dev_julius", ".example.com.", hash)).toBe(
      "dev-julius-abcdef0123456789.example.com",
    );
    expect(managedEndpointHostname("prod", "ras-code-relay.com", hash)).toBe(
      "prod-abcdef0123456789.ras-code-relay.com",
    );
    expect(managedEndpointTunnelName("dev_julius", hash)).toBe(
      "ras-code-relay-managedendpoint-dev-julius-abcdef0123456789",
    );
  });

  it("keeps the DNS label within the provider limit for long stage names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });

  it("accepts allocated hostnames within the relay zone", () => {
    expect(
      isManagedEndpointHostname("dev-julius-abcdef0123456789.example.com", "example.com"),
    ).toBe(true);
    expect(managedEndpointForHostname("dev-julius-abcdef0123456789.example.com")).toEqual({
      httpBaseUrl: "https://dev-julius-abcdef0123456789.example.com/",
      wsBaseUrl: "wss://dev-julius-abcdef0123456789.example.com/ws",
      providerKind: "cloudflare_tunnel",
    });
  });

  it("publishes managed endpoints through a shared path gateway", () => {
    expect(
      managedEndpointForHostname("code-abcdef0123456789.ras.sh", "code-tunnels.ras.sh"),
    ).toEqual({
      httpBaseUrl: "https://code-tunnels.ras.sh/e/abcdef0123456789/",
      wsBaseUrl: "wss://code-tunnels.ras.sh/e/abcdef0123456789/ws",
      providerKind: "cloudflare_tunnel",
    });
  });

  it("keeps the relay's own requests off the gateway it serves", () => {
    expect(managedEndpointRequestOrigin("code-abcdef0123456789.ras.sh")).toBe(
      "https://code-abcdef0123456789.ras.sh/",
    );
  });

  it("resolves gateway paths to the matching internal tunnel hostname", () => {
    const target = managedEndpointGatewayTargetHostname({
      requestUrl: new URL("https://code-tunnels.ras.sh/e/abcdef0123456789/api/thread?cursor=next"),
      gatewayDomain: "code-tunnels.ras.sh",
      baseDomain: "ras.sh",
      namespace: "code",
    });

    expect(target).toBe("code-abcdef0123456789.ras.sh");
  });

  it("rejects malformed and off-domain gateway requests", () => {
    const config = {
      gatewayDomain: "code-tunnels.ras.sh",
      baseDomain: "ras.sh",
      namespace: "code",
    } as const;

    expect(
      managedEndpointGatewayTargetHostname({
        ...config,
        requestUrl: new URL("https://code-tunnels.ras.sh/e/not-an-id/ws"),
      }),
    ).toBeNull();
    expect(
      managedEndpointGatewayTargetHostname({
        ...config,
        requestUrl: new URL("https://attacker.example/e/abcdef0123456789/ws"),
      }),
    ).toBeNull();
  });

  it("rejects hostnames outside the relay zone", () => {
    expect(isManagedEndpointHostname("internal.example.net", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("example.com.attacker.test", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("dev-julius.example.com.", "example.com")).toBe(false);
  });
});
