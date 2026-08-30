import { describe, expect, it } from "@effect/vitest";

import {
  parseManagedEndpointGatewayPath,
  parseRasRelayConnectorPath,
} from "./advertisedEndpoint.ts";

describe("RAS relay endpoint paths", () => {
  it("parses the same endpoint ID shape for public and connector routes", () => {
    expect(parseManagedEndpointGatewayPath("/e/abcdef0123456789/api/health")).toEqual({
      endpointId: "abcdef0123456789",
      downstreamPath: "/api/health",
    });
    expect(parseRasRelayConnectorPath("/v1/ras-relay/connect/abcdef0123456789")).toBe(
      "abcdef0123456789",
    );
  });

  it("rejects invalid endpoint IDs", () => {
    expect(parseManagedEndpointGatewayPath("/e/not-an-endpoint/api/health")).toBeNull();
    expect(parseRasRelayConnectorPath("/v1/ras-relay/connect/not-an-endpoint")).toBeNull();
  });
});
