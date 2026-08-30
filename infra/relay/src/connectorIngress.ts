import * as Headers from "effect/unstable/http/Headers";

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
