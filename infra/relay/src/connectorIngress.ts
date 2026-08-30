import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export function authorizeConnectorIngress(input: {
  readonly authenticatedEndpointId: string | null;
  readonly requestedEndpointId: string;
  readonly headers: Headers.Headers;
}): { readonly endpointId: string; readonly headers: Headers.Headers } | null {
  if (input.authenticatedEndpointId !== input.requestedEndpointId) return null;
  return {
    endpointId: input.authenticatedEndpointId,
    headers: Headers.set(
      Headers.remove(input.headers, "authorization"),
      "x-ras-relay-connector",
      "1",
    ),
  };
}

export const forwardRelayRequest = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  headers: Headers.Headers,
) {
  const source = yield* HttpServerRequest.toWeb(request);
  return HttpServerRequest.fromWeb(new Request(source, { headers }));
});
