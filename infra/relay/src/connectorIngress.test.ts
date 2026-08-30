import { describe, expect, it } from "vite-plus/test";
import * as Headers from "effect/unstable/http/Headers";

import { authorizeConnectorIngress } from "./connectorIngress.ts";

describe("authorizeConnectorIngress", () => {
  it("rejects credentials derived for another endpoint", () => {
    expect(
      authorizeConnectorIngress({
        authenticatedEndpointId: "aaaaaaaaaaaaaaaa",
        requestedEndpointId: "bbbbbbbbbbbbbbbb",
        headers: Headers.fromInput({ authorization: "Bearer secret" }),
      }),
    ).toBeNull();
  });

  it("routes matching credentials without forwarding authorization", () => {
    const routed = authorizeConnectorIngress({
      authenticatedEndpointId: "aaaaaaaaaaaaaaaa",
      requestedEndpointId: "aaaaaaaaaaaaaaaa",
      headers: Headers.fromInput({ authorization: "Bearer secret", "x-request-id": "request-1" }),
    });

    expect(routed?.endpointId).toBe("aaaaaaaaaaaaaaaa");
    expect(routed?.headers.authorization).toBeUndefined();
    expect(routed?.headers["x-ras-relay-connector"]).toBe("1");
    expect(routed?.headers["x-request-id"]).toBe("request-1");
  });
});
