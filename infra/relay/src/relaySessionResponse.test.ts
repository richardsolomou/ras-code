import { describe, expect, it } from "@effect/vitest";
import { isScopeEjected } from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { prepareRelaySessionResponse } from "./relaySessionResponse.ts";

const upstreamUpgrade = () => {
  const headers = new Headers({ "sec-websocket-protocol": "ras-code" });
  headers.set = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  return { status: 101, headers, webSocket: { socket: true } } as unknown as Response;
};

class UpgradeCapableResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly webSocket: unknown;
  constructor(_body: unknown, init?: ResponseInit & { webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.headers = new Headers(init?.headers);
    this.webSocket = init?.webSocket;
  }
}

const run = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    const original = globalThis.Response;
    (globalThis as { Response: unknown }).Response = UpgradeCapableResponse;
    const scope = Scope.makeUnsafe();
    try {
      const value = yield* prepareRelaySessionResponse(response).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { value, ejected: isScopeEjected(scope) };
    } finally {
      (globalThis as { Response: unknown }).Response = original;
    }
  });

const upgradeResponse = (source: Response) =>
  HttpServerResponse.setBody(HttpServerResponse.empty({ status: 101 }), HttpBody.raw(source));

const rawBody = (response: HttpServerResponse.HttpServerResponse) =>
  (response.body as HttpBody.Raw).body as Response & { readonly webSocket?: unknown };

describe("prepareRelaySessionResponse", () => {
  it.effect("returns a mutable upgrade with the upstream socket and protocol", () =>
    Effect.gen(function* () {
      const source = upstreamUpgrade();
      const { value } = yield* run(upgradeResponse(source));
      const returned = rawBody(value);

      expect({
        replaced: returned !== source,
        socket: returned.webSocket,
        protocol: returned.headers.get("sec-websocket-protocol"),
        headersMutable: (() => {
          try {
            returned.headers.set("traceparent", "00-abc-def-01");
            return true;
          } catch {
            return false;
          }
        })(),
      }).toEqual({
        replaced: true,
        socket: (source as Response & { readonly webSocket?: unknown }).webSocket,
        protocol: "ras-code",
        headersMutable: true,
      });
    }),
  );

  it.effect("ejects only upgrade request scopes", () =>
    Effect.gen(function* () {
      const upgrade = yield* run(upgradeResponse(upstreamUpgrade()));
      const ordinary = yield* run(HttpServerResponse.text("ok"));

      expect({
        upgradeEjected: upgrade.ejected,
        ordinaryEjected: ordinary.ejected,
        ordinaryStatus: ordinary.value.status,
      }).toEqual({
        upgradeEjected: true,
        ordinaryEjected: false,
        ordinaryStatus: 200,
      });
    }),
  );
});
