import { describe, expect, it } from "@effect/vitest";
import { isScopeEjected } from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import { managedEndpointGatewayResponse } from "./worker.ts";

/** A 101 cannot be constructed through `new Response` outside Workers. */
const upgradeResponse = () =>
  Object.create(Response.prototype, {
    status: { value: 101 },
    headers: { value: new Headers() },
  }) as Response;

describe("managedEndpointGatewayResponse", () => {
  it.effect("ejects the request scope for a proxied upgrade", () =>
    Effect.gen(function* () {
      // The bridge closes a scope that is not ejected as soon as the handler
      // returns, which takes the still-live proxied socket with it.
      const scope = Scope.makeUnsafe();

      yield* managedEndpointGatewayResponse(upgradeResponse()).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      expect(isScopeEjected(scope)).toBe(true);
    }),
  );

  it.effect("leaves the scope alone for an ordinary response", () =>
    Effect.gen(function* () {
      const scope = Scope.makeUnsafe();

      const response = yield* managedEndpointGatewayResponse(
        new Response("hi", { status: 200 }),
      ).pipe(Effect.provideService(Scope.Scope, scope));

      expect(isScopeEjected(scope)).toBe(false);
      expect(response.status).toBe(200);
    }),
  );
});
