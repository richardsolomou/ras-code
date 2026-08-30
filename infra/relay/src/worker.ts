import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Headers from "effect/unstable/http/Headers";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@ras-code/contracts/relay";
import {
  parseManagedEndpointGatewayPath,
  parseRasRelayConnectorPath,
} from "@ras-code/shared/advertisedEndpoint";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { RelayApiZone, RelayDeploymentConfig, RelayGatewayZone } from "./zone.ts";
import { makeRelayTraceLayer, RelayTracingConfig } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import { makeInternalManagedEndpointHttpClient } from "./environments/internalManagedEndpointHttpClient.ts";
import { RasRelaySession, RasRelaySessionDirectory } from "./environments/RasRelaySession.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import { rasRelayEndpointDigestInput, rasRelayEndpointId } from "./deploymentConfig.ts";
import { authorizeConnectorIngress, forwardRelayRequest } from "./connectorIngress.ts";
import { prepareRelaySessionResponse } from "./relaySessionResponse.ts";
import { layer as webcryptoLayer } from "./webcrypto.ts";

function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return match?.[1]?.trim() || null;
}

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayGatewayDomain, relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: { name: relayPublicDomain, aliases: [relayGatewayDomain] },
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayGatewayDomain, relayEndpointNamespace, relayPublicDomain, relayPublicOrigin } =
      yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const relayGatewayZone = yield* RelayGatewayZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const tracing = yield* RelayTracingConfig;

    //
    // 2. Create bindings
    //
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    );
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY");
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString);

    const rasRelaySessions = yield* RasRelaySession;
    const internalManagedEndpointHttpClient = makeInternalManagedEndpointHttpClient({
      gatewayDomain: relayGatewayDomain,
      fetch: (endpointId, request) =>
        rasRelaySessions
          .getByName(endpointId)
          .fetch(HttpServerRequest.fromWeb(request))
          .pipe(Effect.map(HttpServerResponse.toWeb), Effect.orDie),
    });
    // Keep Worker custom-domain reconciliation ordered after zone provisioning.
    yield* yield* relayApiZone.zoneId;
    yield* yield* relayGatewayZone.zoneId;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        relayGatewayDomain,
        relayEndpointNamespace,
      });
    });

    const relayTraceLayer = makeRelayTraceLayer(tracing);

    const rasRelaySessionDirectoryLayer = Layer.effect(
      RasRelaySessionDirectory,
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return RasRelaySessionDirectory.of({
          disconnect: ({ environmentId, environmentPublicKey }) =>
            Effect.gen(function* () {
              if (!relayEndpointNamespace) return;
              const hash = yield* crypto.digest(
                "SHA-256",
                new TextEncoder().encode(
                  rasRelayEndpointDigestInput(
                    relayEndpointNamespace,
                    environmentId,
                    environmentPublicKey,
                  ),
                ),
              );
              yield* rasRelaySessions
                .getByName(rasRelayEndpointId(Encoding.encodeHex(hash)))
                .disconnect();
            }).pipe(Effect.orDie),
        });
      }),
    );

    const runtimeLayer = Layer.empty.pipe(
      Layer.provideMerge(Layer.mergeAll(rasRelaySessionDirectoryLayer, MobileRegistrations.layer)),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(
        EnvironmentConnector.layer.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, internalManagedEndpointHttpClient)),
        ),
      ),
      Layer.provideMerge(
        EnvironmentLinker.layer.pipe(Layer.provideMerge(rasRelaySessionDirectoryLayer)),
      ),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(ManagedEndpointProvider.layer),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(EnvironmentLinks.layer),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(
          Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        ),
      ),
      Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
      Layer.provideMerge(webcryptoLayer),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const relayApiFetch = yield* Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(HttpRouter.toHttpEffect);

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestUrl = HttpServerRequest.toURL(request);
      const connectorEndpointId =
        requestUrl._tag === "Some" && requestUrl.value.hostname === relayPublicDomain
          ? parseRasRelayConnectorPath(requestUrl.value.pathname)
          : null;
      if (connectorEndpointId) {
        const token = bearerToken(request.headers.authorization);
        if (!token || !relayEndpointNamespace) {
          return HttpServerResponse.empty({ status: 401 });
        }
        const authenticateConnector = Effect.gen(function* () {
          const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
          const links = yield* EnvironmentLinks.EnvironmentLinks;
          const crypto = yield* Crypto.Crypto;
          const principal = yield* credentials.authenticate(token);
          if (Option.isNone(principal)) return null;
          const managedRelayKeyActive = yield* links.isManagedRelayPublicKeyActive({
            environmentId: principal.value.environmentId,
            environmentPublicKey: principal.value.environmentPublicKey,
          });
          if (!managedRelayKeyActive) return null;
          const hash = yield* crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(
                rasRelayEndpointDigestInput(
                  relayEndpointNamespace,
                  principal.value.environmentId,
                  principal.value.environmentPublicKey,
                ),
              ),
            )
            .pipe(Effect.map(Encoding.encodeHex));
          return rasRelayEndpointId(hash);
        }).pipe(Effect.provide(runtimeLayer), Effect.result);
        const authorization = yield* authenticateConnector;
        if (Result.isFailure(authorization)) {
          yield* Effect.logError("RAS relay connector authorization failed", {
            cause: authorization.failure,
          });
          return HttpServerResponse.empty({ status: 503 });
        }
        const route = authorizeConnectorIngress({
          authenticatedEndpointId: authorization.success,
          requestedEndpointId: connectorEndpointId,
          headers: request.headers,
        });
        if (!route) {
          return HttpServerResponse.empty({ status: 403 });
        }
        const connectorRequest = yield* forwardRelayRequest(request, route.headers);
        const session = rasRelaySessions.getByName(route.endpointId);
        const response = yield* session.fetch(connectorRequest).pipe(Effect.orDie);
        const confirmed = yield* authenticateConnector;
        if (Result.isFailure(confirmed)) {
          yield* Effect.logError("RAS relay connector reauthorization failed", {
            cause: confirmed.failure,
          });
          yield* session.disconnect().pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 503 });
        }
        if (confirmed.success !== route.endpointId) {
          yield* session.disconnect().pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 403 });
        }
        return yield* prepareRelaySessionResponse(response);
      }
      if (requestUrl._tag === "None" || requestUrl.value.hostname !== relayGatewayDomain) {
        return yield* relayApiFetch;
      }

      const route = parseManagedEndpointGatewayPath(requestUrl.value.pathname);
      if (!route) {
        return HttpServerResponse.empty({ status: 404 });
      }
      return yield* rasRelaySessions
        .getByName(route.endpointId)
        .fetch(
          yield* forwardRelayRequest(
            request,
            Headers.remove(request.headers, "x-ras-relay-connector"),
          ),
        )
        .pipe(Effect.orDie, Effect.flatMap(prepareRelaySessionResponse));
    }).pipe(withoutCapturedParentSpan, (httpEffect) =>
      traceRelayHttpRequestWith(httpEffect, relayTraceLayer),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
      ),
    ),
  ),
);

export default ApiLive;
