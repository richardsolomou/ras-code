import type { RelayManagedEndpoint } from "@ras-code/contracts/relay";
import { deriveWsBaseUrl } from "@ras-code/shared/advertisedEndpoint";
import * as Schema from "effect/Schema";

const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
export const RELAY_GATEWAY_ZONE_OWNER_STAGE = "prod";

/**
 * Hostname label the relay publishes under. Prefixed so the relay is
 * identifiable on a zone shared with unrelated services, matching the hosted
 * app's `code` and the gateway's `code-tunnels`.
 */
const RELAY_LABEL = "code-relay";

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

function stableSuffix(hash: string): string {
  return hash.toLowerCase().slice(0, MANAGED_ENDPOINT_HASH_LENGTH);
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

export function relayEndpointNamespaceForStage(stage: string, override?: string): string {
  const configured = override?.trim();
  return relayStageSlug(configured || stage);
}

export function relayOwnsGatewayZone(stage: string): boolean {
  return stage === RELAY_GATEWAY_ZONE_OWNER_STAGE;
}

export function relayPublicDomainForStage(stage: string, zoneName: string): string {
  const stageSlug = relayStageSlug(stage);
  const relayLabel = stage === "prod" ? RELAY_LABEL : `${RELAY_LABEL}-${stageSlug}`;
  if (relayLabel.length > DNS_LABEL_MAX_LENGTH) {
    throw new RelayPublicDomainLabelTooLongError({
      stage,
      label: relayLabel,
      maxLength: DNS_LABEL_MAX_LENGTH,
    });
  }
  return `${relayLabel}.${normalizeZoneName(zoneName)}`;
}

export function rasRelayEndpointDigestInput(
  stage: string,
  environmentId: string,
  environmentPublicKey: string,
): string {
  return `${stage}:ras-relay:${environmentId}:${environmentPublicKey}`;
}

export function rasRelayEndpointId(hash: string): string {
  return stableSuffix(hash);
}

export function rasRelayEndpointForId(
  gatewayDomain: string,
  endpointId: string,
): RelayManagedEndpoint {
  const gatewayOrigin = `https://${normalizeZoneName(gatewayDomain)}`;
  const httpBaseUrl = `${gatewayOrigin}/e/${endpointId}/`;
  return {
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    providerKind: "ras_relay",
  };
}
