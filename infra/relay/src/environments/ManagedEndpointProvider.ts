import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@ras-code/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import {
  rasRelayEndpointDigestInput,
  rasRelayEndpointForId,
  rasRelayEndpointId,
} from "../deploymentConfig.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedErrorClass<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals(["relayGatewayDomain", "relayEndpointNamespace"]),
    ),
  },
) {}

export class ManagedEndpointProvisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: Schema.Literal("derive-environment-hash"),
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedErrorClass<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: Omit<RelayManagedEndpointRuntimeConfig, "connectorToken">;
}

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
  }
>()("ras-code-relay/environments/ManagedEndpointProvider") {}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;

  return ManagedEndpointProvider.of({
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      if (!config.relayGatewayDomain || !config.relayEndpointNamespace) {
        return yield* new ManagedEndpointProvisioningNotConfigured({
          userId: input.userId,
          environmentId: input.environmentId,
          missingSettings: [
            ...(config.relayGatewayDomain ? [] : (["relayGatewayDomain"] as const)),
            ...(config.relayEndpointNamespace ? [] : (["relayEndpointNamespace"] as const)),
          ],
        });
      }
      const environmentHash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            rasRelayEndpointDigestInput(config.relayEndpointNamespace, input.environmentId),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "derive-environment-hash",
                cause,
              }),
          ),
        );
      const endpointId = rasRelayEndpointId(environmentHash);
      const connectorUrl = new URL(`/v1/ras-relay/connect/${endpointId}`, config.relayIssuer);
      connectorUrl.protocol = connectorUrl.protocol === "https:" ? "wss:" : "ws:";
      return {
        endpoint: rasRelayEndpointForId(config.relayGatewayDomain, endpointId),
        runtime: {
          providerKind: "ras_relay",
          connectorUrl: connectorUrl.toString(),
          localHttpHost: input.origin.localHttpHost,
          localHttpPort: input.origin.localHttpPort,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
