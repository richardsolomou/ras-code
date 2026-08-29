import { describe, expect, it } from "@effect/vitest";
import { isScopeEjected } from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import { managedEndpointGatewayResponse } from "./worker.ts";

/**
 * Stands in for the response a Workers subrequest returns for an upgrade: it
 * carries a socket, and its headers reject writes, which is what made the
 * pipeline's `traceparent` throw. Node rejects both, so the source is a stub
 * and `Response` is swapped for one that tolerates a 101 while the gateway runs.
 */
const upstreamUpgrade = () => {
  const headers = new Headers();
  headers.set = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  return { status: 101, headers, webSocket: { socket: true } } as unknown as Response;
};

class UpgradeCapableResponse {
  readonly status: number;
  readonly headers = new Headers();
  readonly webSocket: unknown;
  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}

const runGateway = (source: Response) =>
  Effect.gen(function* () {
    const original = globalThis.Response;
    (globalThis as { Response: unknown }).Response = UpgradeCapableResponse;
    const scope = Scope.makeUnsafe();
    try {
      const value = yield* managedEndpointGatewayResponse(source).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { value, ejected: isScopeEjected(scope) };
    } finally {
      (globalThis as { Response: unknown }).Response = original;
    }
  });

const rawBody = (response: { readonly body: unknown }) =>
  (response.body as { readonly body: Response & { webSocket?: unknown } }).body;

describe("managedEndpointGatewayResponse", () => {
  it.effect("hands back a response whose headers the pipeline can still write", () =>
    Effect.gen(function* () {
      const source = upstreamUpgrade();
      const { value } = yield* runGateway(source);

      const returned = rawBody(value);
      expect(returned).not.toBe(source);
      // The pipeline appends a traceparent to every response. On the upstream
      // object that throws and the worker dies with a 1101.
      expect(() => returned.headers.set("traceparent", "00-abc-def-01")).not.toThrow();
    }),
  );

  it.effect("carries the upstream socket on the response it returns", () =>
    Effect.gen(function* () {
      const source = upstreamUpgrade();
      const { value } = yield* runGateway(source);

      expect(rawBody(value).webSocket).toBe(
        (source as Response & { webSocket?: unknown }).webSocket,
      );
    }),
  );

  it.effect("ejects the request scope so the bridge leaves the socket open", () =>
    Effect.gen(function* () {
      const { ejected } = yield* runGateway(upstreamUpgrade());

      expect(ejected).toBe(true);
    }),
  );

  it.effect("leaves an ordinary response alone", () =>
    Effect.gen(function* () {
      const { value, ejected } = yield* runGateway(new Response("hi", { status: 200 }));

      expect(ejected).toBe(false);
      expect(value.status).toBe(200);
    }),
  );
});
