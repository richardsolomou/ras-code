import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@t3tools/contracts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly desktopCompatibility?: "compatible" | "unknown";
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

export function normalizeHttpBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }

  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.pathname !== "/") {
    url.pathname += "ws";
  }
  return url.toString();
}

export function appendPathnameToBaseUrl(baseUrl: string, pathname: string): string {
  const url = new URL(normalizeHttpBaseUrl(baseUrl));
  url.pathname += pathname.replace(/^\/+/, "");
  return url.toString();
}

export interface ManagedEndpointGatewayPath {
  readonly endpointId: string;
  readonly downstreamPath: string;
}

const RAS_RELAY_ENDPOINT_ID = /^[a-f0-9]{16}$/u;

export function parseRasRelayConnectorPath(pathname: string): string | null {
  const prefix = "/v1/ras-relay/connect/";
  const endpointId = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  return RAS_RELAY_ENDPOINT_ID.test(endpointId) ? endpointId : null;
}

export function parseManagedEndpointGatewayPath(
  pathname: string,
): ManagedEndpointGatewayPath | null {
  const match = /^\/e\/([^/]+)(\/.*)?$/u.exec(pathname);
  return match
    ? RAS_RELAY_ENDPOINT_ID.test(match[1]!)
      ? {
          endpointId: match[1]!,
          downstreamPath: match[2] || "/",
        }
      : null
    : null;
}

export function stripManagedEndpointGatewayPrefix(requestUrl: string): string | null {
  const queryIndex = requestUrl.indexOf("?");
  const pathname = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const route = parseManagedEndpointGatewayPath(pathname);
  return route
    ? `${route.downstreamPath}${queryIndex === -1 ? "" : requestUrl.slice(queryIndex)}`
    : null;
}

export function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ?? classifyHostedHttpsCompatibility(httpBaseUrl),
      desktopApp: input.desktopCompatibility ?? "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
