import { describe, expect, it } from "vite-plus/test";

import {
  appendPathnameToBaseUrl,
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
  parseManagedEndpointGatewayPath,
  stripManagedEndpointGatewayPrefix,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe(
      "https://example.com/path/",
    );
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/socket/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/api/ws");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
    expect(appendPathnameToBaseUrl("https://gateway.test/e/abcdef0123456789", "/oauth/token")).toBe(
      "https://gateway.test/e/abcdef0123456789/oauth/token",
    );
  });

  it("parses and strips managed endpoint gateway paths", () => {
    expect(parseManagedEndpointGatewayPath("/e/abcdef0123456789/api/auth/session")).toEqual({
      endpointId: "abcdef0123456789",
      downstreamPath: "/api/auth/session",
    });
    expect(stripManagedEndpointGatewayPrefix("/e/abcdef0123456789/ws?ticket=one")).toBe(
      "/ws?ticket=one",
    );
    expect(stripManagedEndpointGatewayPrefix("/e/not-an-endpoint/ws")).toBeNull();
  });

  it("marks HTTP endpoints as blocked from hosted HTTPS apps", () => {
    expect(classifyHostedHttpsCompatibility("http://192.168.1.44:3773")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://desktop.example.com", "compatible")).toBe(
      "compatible",
    );
  });

  it("creates provider-neutral endpoint records", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan:http://192.168.1.44:3773",
        label: "LAN",
        provider: coreProvider,
        httpBaseUrl: "http://192.168.1.44:3773",
        reachability: "lan",
        source: "desktop-core",
        isDefault: true,
      }),
    ).toEqual({
      id: "lan:http://192.168.1.44:3773",
      label: "LAN",
      provider: coreProvider,
      httpBaseUrl: "http://192.168.1.44:3773/",
      wsBaseUrl: "ws://192.168.1.44:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
      isDefault: true,
    });
  });
});
