import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const prepareRelaySessionResponse = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
) {
  if (response.status !== 101 || response.body._tag !== "Raw") return response;

  HttpEffect.scopeDisableClose(yield* Effect.scope);
  const source = response.body.body as Response & { readonly webSocket?: unknown };
  const upgrade = new Response(null, {
    status: 101,
    headers: source.headers,
    webSocket: source.webSocket,
  } as ResponseInit);
  return HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: 101 }),
    HttpBody.raw(upgrade),
  );
});
