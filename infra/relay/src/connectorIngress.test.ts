import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { authorizeConnectorIngress, forwardRelayRequest } from "./connectorIngress.ts";

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

  it.effect("forwards header changes to the durable object", () =>
    Effect.gen(function* () {
      const source = new Request(
        "https://code-relay.example.test/v1/ras-relay/connect/aaaaaaaaaaaaaaaa",
        {
          headers: {
            authorization: "Bearer secret",
            upgrade: "websocket",
            "x-request-id": "request-1",
          },
        },
      );
      const request = HttpServerRequest.fromWeb(source);
      const routed = authorizeConnectorIngress({
        authenticatedEndpointId: "aaaaaaaaaaaaaaaa",
        requestedEndpointId: "aaaaaaaaaaaaaaaa",
        headers: request.headers,
      });

      const forwarded = yield* forwardRelayRequest(request, routed!.headers);
      const webRequest = yield* HttpServerRequest.toWeb(forwarded);

      expect(Object.fromEntries(webRequest.headers)).toEqual({
        upgrade: "websocket",
        "x-ras-relay-connector": "1",
        "x-request-id": "request-1",
      });
    }),
  );
});
