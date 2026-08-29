import { isScopeEjected } from "alchemy/Http";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import { managedEndpointGatewayResponse } from "./worker.ts";

const runWithScope = <A>(effect: Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = Scope.makeUnsafe();
      const value = yield* effect.pipe(Effect.provideService(Scope.Scope, scope));
      return { value, ejected: isScopeEjected(scope) };
    }),
  );

describe("managedEndpointGatewayResponse", () => {
  it("ejects the request scope for a proxied upgrade", async () => {
    // The bridge closes a scope that is not ejected as soon as the handler
    // returns, which takes the still-live proxied socket with it.
    const upgrade = Object.create(Response.prototype, {
      status: { value: 101 },
      headers: { value: new Headers() },
    }) as Response;

    const { ejected } = await runWithScope(managedEndpointGatewayResponse(upgrade));

    expect(ejected).toBe(true);
  });

  it("leaves the scope alone for an ordinary response", async () => {
    const { value, ejected } = await runWithScope(
      managedEndpointGatewayResponse(new Response("hi", { status: 200 })),
    );

    expect(ejected).toBe(false);
    expect(value.status).toBe(200);
  });
});
