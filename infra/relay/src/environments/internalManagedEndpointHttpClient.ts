import { parseManagedEndpointGatewayPath } from "@ras-code/shared/advertisedEndpoint";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

function transportError(request: HttpClientRequest.HttpClientRequest, cause: unknown) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause,
      description: "Managed endpoint request failed",
    }),
  });
}

export function makeInternalManagedEndpointHttpClient(input: {
  readonly gatewayDomain: string;
  readonly fetch: (endpointId: string, request: Request) => Effect.Effect<Response>;
}): HttpClient.HttpClient {
  return HttpClient.make((request, url, signal) => {
    const route =
      url.hostname === input.gatewayDomain ? parseManagedEndpointGatewayPath(url.pathname) : null;
    if (!route) {
      return Effect.fail(transportError(request, "Request is not for a managed relay endpoint"));
    }
    return HttpClientRequest.toWeb(request, { signal }).pipe(
      Effect.flatMap((source) => input.fetch(route.endpointId, source)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.catchCause((cause) => Effect.fail(transportError(request, Cause.squash(cause)))),
    );
  });
}
