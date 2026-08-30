import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { makeInternalManagedEndpointHttpClient } from "./internalManagedEndpointHttpClient.ts";

describe("makeInternalManagedEndpointHttpClient", () => {
  it.effect("routes managed endpoint requests through the relay session", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly endpointId: string; readonly request: Request }> = [];
      const client = makeInternalManagedEndpointHttpClient({
        gatewayDomain: "code-tunnels.example.test",
        fetch: (endpointId, request) => {
          seen.push({ endpointId, request });
          return Effect.succeed(Response.json({ ok: true }));
        },
      });
      const request = HttpClientRequest.make("POST")(
        "https://code-tunnels.example.test/e/abcdef0123456789/api/connect/mint-credential",
      ).pipe(HttpClientRequest.bodyText('{"proof":"signed"}', "application/json"));

      const response = yield* client.execute(request);

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.endpointId).toBe("abcdef0123456789");
      expect(seen[0]?.request.url).toBe(
        "https://code-tunnels.example.test/e/abcdef0123456789/api/connect/mint-credential",
      );
      expect(yield* Effect.promise(() => seen[0]!.request.text())).toBe('{"proof":"signed"}');
    }),
  );

  it.effect("rejects requests outside the managed gateway", () =>
    Effect.gen(function* () {
      const client = makeInternalManagedEndpointHttpClient({
        gatewayDomain: "code-tunnels.example.test",
        fetch: () => Effect.die("unexpected fetch"),
      });

      const error = yield* Effect.flip(
        client.get("https://other.example.test/e/abcdef0123456789/api/connect/health"),
      );

      expect(error.reason._tag).toBe("TransportError");
    }),
  );
});
