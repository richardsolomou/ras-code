import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  RELAY_GATEWAY_ZONE_OWNER_STAGE,
  relayEndpointNamespaceForStage,
  relayOwnsGatewayZone,
  relayPublicDomainForStage,
} from "./deploymentConfig.ts";

function withLogicalId<Resource extends object>(resource: Resource, logicalId: string): Resource {
  return new Proxy(resource, {
    has: (target, property) => property === "LogicalId" || property in target,
    get: (target, property, receiver) =>
      property === "LogicalId" ? logicalId : Reflect.get(target, property, receiver),
  });
}

export const RelayDeploymentConfig = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const relayApiZoneName = yield* Config.nonEmptyString("RELAY_API_ZONE_NAME");
  const relayGatewayZoneName = yield* Config.nonEmptyString("RELAY_GATEWAY_ZONE_NAME");
  const relayGatewayDomain = yield* Config.nonEmptyString("RELAY_GATEWAY_DOMAIN");
  const relayEndpointNamespaceOverride = yield* Config.string("RELAY_ENDPOINT_NAMESPACE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  );
  const relayPublicDomainOverride = yield* Config.string("RELAY_DOMAIN").pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed ? Option.some(trimmed) : Option.none();
      }),
    ),
  );
  const relayPublicDomain = Option.getOrElse(relayPublicDomainOverride, () =>
    relayPublicDomainForStage(stage, relayApiZoneName),
  );

  return {
    stage,
    relayPublicDomain,
    relayPublicOrigin: `https://${relayPublicDomain}`,
    relayApiZoneName,
    relayGatewayZoneName,
    relayGatewayDomain,
    relayEndpointNamespace: relayEndpointNamespaceForStage(stage, relayEndpointNamespaceOverride),
  };
});

export const RelayGatewayZone = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, relayGatewayZoneName }) =>
    relayOwnsGatewayZone(stage)
      ? Cloudflare.Zone.Zone("RelayGatewayZone", { name: relayGatewayZoneName }).pipe(adopt(true))
      : Cloudflare.Zone.Zone.ref("RelayGatewayZone", {
          stage: RELAY_GATEWAY_ZONE_OWNER_STAGE,
        }).pipe(
          // Alchemy beta's DNS binding policy uses LogicalId to derive a
          // stable SID, but Resource.ref returns a lazy output proxy.
          Effect.map((zone) => withLogicalId(zone, "RelayGatewayZone")),
        ),
  ),
);

export const RelayApiZone = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, relayApiZoneName, relayGatewayZoneName }) =>
    relayApiZoneName === relayGatewayZoneName
      ? RelayGatewayZone
      : relayOwnsGatewayZone(stage)
        ? Cloudflare.Zone.Zone("RelayApiZone", { name: relayApiZoneName }).pipe(adopt(true))
        : Cloudflare.Zone.Zone.ref("RelayApiZone", {
            stage: RELAY_GATEWAY_ZONE_OWNER_STAGE,
          }),
  ),
);
