import type { RelayManagedEndpoint } from "@ras-code/contracts/relay";
import { parseManagedEndpointGatewayPath } from "@ras-code/shared/advertisedEndpoint";
import * as Schema from "effect/Schema";

const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_ID_PATTERN = /^[a-f0-9]{16}$/u;
const MANAGED_ENDPOINT_TUNNEL_PREFIX = "ras-code-relay-managedendpoint";
export const MANAGED_ENDPOINT_ZONE_OWNER_STAGE = "prod";

export class RelayPublicDomainLabelTooLongError extends Schema.TaggedErrorClass<RelayPublicDomainLabelTooLongError>()(
  "RelayPublicDomainLabelTooLongError",
  {
    stage: Schema.String,
    label: Schema.String,
    maxLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Relay stage '${this.stage}' produces custom domain label '${this.label}' (${this.label.length} characters), exceeding the DNS label limit of ${this.maxLength}.`;
  }
}

function normalizeZoneName(zoneName: string): string {
  return zoneName
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function isDnsName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 253 &&
    name
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= DNS_LABEL_MAX_LENGTH &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function stableSuffix(hash: string): string {
  return hash.toLowerCase().slice(0, MANAGED_ENDPOINT_HASH_LENGTH);
}

function appendDnsSafeSuffix(prefix: string, suffix: string): string {
  const truncatedPrefix = prefix
    .slice(0, DNS_LABEL_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/g, "");
  return `${truncatedPrefix}-${suffix}`;
}

/**
 * Alchemy's physical-name helper sanitizes resource names after adding the
 * stage. Keep custom domains and runtime-created resources aligned with it.
 */
export function relayStageSlug(stage: string): string {
  return stage
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function relayResourceNameForStage(name: string, stage: string): string {
  return `${name}-${relayStageSlug(stage)}`;
}

export function managedEndpointNamespaceForStage(stage: string, override?: string): string {
  const configured = override?.trim();
  return relayStageSlug(configured || stage);
}

export function relayOwnsManagedEndpointZone(stage: string): boolean {
  return stage === MANAGED_ENDPOINT_ZONE_OWNER_STAGE;
}

export function relayPublicDomainForStage(stage: string, zoneName: string): string {
  const stageSlug = relayStageSlug(stage);
  const relayLabel = stage === "prod" ? "relay" : `relay-${stageSlug}`;
  if (relayLabel.length > DNS_LABEL_MAX_LENGTH) {
    throw new RelayPublicDomainLabelTooLongError({
      stage,
      label: relayLabel,
      maxLength: DNS_LABEL_MAX_LENGTH,
    });
  }
  return `${relayLabel}.${normalizeZoneName(zoneName)}`;
}

export function managedEndpointDigestInput(
  stage: string,
  userId: string,
  environmentId: string,
): string {
  return `${stage}:${userId}:${environmentId}`;
}

export function managedEndpointHostname(stage: string, baseDomain: string, hash: string): string {
  const label = appendDnsSafeSuffix(relayStageSlug(stage), stableSuffix(hash));
  return `${label}.${normalizeZoneName(baseDomain)}`;
}

export function isManagedEndpointHostname(hostname: string, baseDomain: string): boolean {
  const normalizedHostname = normalizeZoneName(hostname);
  const normalizedBaseDomain = normalizeZoneName(baseDomain);
  return (
    hostname === normalizedHostname &&
    isDnsName(normalizedHostname) &&
    isDnsName(normalizedBaseDomain) &&
    normalizedHostname.endsWith(`.${normalizedBaseDomain}`)
  );
}

function managedEndpointId(hostname: string): string | null {
  const label = normalizeZoneName(hostname).split(".")[0];
  const id = label?.slice(-(MANAGED_ENDPOINT_HASH_LENGTH + 1));
  return id?.startsWith("-") && MANAGED_ENDPOINT_ID_PATTERN.test(id.slice(1)) ? id.slice(1) : null;
}

export function managedEndpointForHostname(
  hostname: string,
  gatewayDomain?: string,
): RelayManagedEndpoint {
  const id = managedEndpointId(hostname);
  if (gatewayDomain && id) {
    const gatewayOrigin = `https://${normalizeZoneName(gatewayDomain)}`;
    return {
      httpBaseUrl: `${gatewayOrigin}/e/${id}/`,
      wsBaseUrl: `${gatewayOrigin.replace(/^http/u, "ws")}/e/${id}/ws`,
      providerKind: "cloudflare_tunnel",
    };
  }
  return {
    httpBaseUrl: `https://${hostname}/`,
    wsBaseUrl: `wss://${hostname}/ws`,
    providerKind: "cloudflare_tunnel",
  };
}

export function managedEndpointGatewayTargetHostname(input: {
  readonly requestUrl: URL;
  readonly gatewayDomain: string;
  readonly baseDomain: string;
  readonly namespace: string;
}): string | null {
  if (input.requestUrl.hostname !== normalizeZoneName(input.gatewayDomain)) {
    return null;
  }
  const route = parseManagedEndpointGatewayPath(input.requestUrl.pathname);
  if (!route) {
    return null;
  }
  return managedEndpointHostname(input.namespace, input.baseDomain, route.endpointId);
}

export function managedEndpointTunnelName(stage: string, hash: string): string {
  return `${MANAGED_ENDPOINT_TUNNEL_PREFIX}-${relayStageSlug(stage)}-${stableSuffix(hash)}`;
}
