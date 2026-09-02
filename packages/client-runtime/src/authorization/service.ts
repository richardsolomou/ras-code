import {
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@ras-code/contracts";
import type {
  RelayEnvironmentBundledSession,
  RelayManagedEndpoint,
} from "@ras-code/contracts/relay";
import { oauthScopeSetEquals } from "@ras-code/shared/oauthScope";
import {
  buildRemoteWebSocketConnectionUrl,
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  environmentMismatchError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface RelayEnvironmentAuthorization {
  readonly environmentId: EnvironmentId;
  readonly endpoint: RelayManagedEndpoint;
  /** Absent when the environment bundled a ready session instead. */
  readonly credential?: string | undefined;
  /** Supplied by environments new enough to sign it into the mint response. */
  readonly descriptor?: ExecutionEnvironmentDescriptor | undefined;
  /**
   * A ready access token plus websocket ticket minted alongside the connect
   * response, saving the token-exchange and ticket round trips.
   */
  readonly session?: RelayEnvironmentBundledSession | undefined;
}

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly obtainBootstrap: Effect.Effect<
        RelayEnvironmentAuthorization,
        ConnectionAttemptError
      >;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@ras-code/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000;

function mapDpopSocketError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteDpopEnvironmentError(error);
}

/**
 * The environment answered but would not honor the cached token, so only a
 * fresh credential can help. Timeouts, network faults, and 5xx-shaped noise
 * are not evidence against the token and must not evict it.
 */
function isCachedTokenRejection(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
    case "EnvironmentRequestInvalidError":
    case "EnvironmentResourceNotFoundError":
      return true;
    default:
      return false;
  }
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
});

export const make = Effect.gen(function* () {
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
  const bearerDescriptors = yield* Ref.make<
    ReadonlyMap<
      EnvironmentId,
      {
        readonly httpBaseUrl: string;
        readonly descriptor: ExecutionEnvironmentDescriptor;
        readonly validatedAtEpochMs: number;
      }
    >
  >(new Map());

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const cachedDescriptor = (yield* Ref.get(bearerDescriptors)).get(input.expectedEnvironmentId);
      const canReuseDescriptor =
        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&
        cachedDescriptor.validatedAtEpochMs + BEARER_DESCRIPTOR_CACHE_TTL_MS > now;
      const descriptor = canReuseDescriptor
        ? cachedDescriptor.descriptor
        : yield* fetchDescriptor(input.httpBaseUrl).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      if (!canReuseDescriptor) {
        yield* Ref.update(bearerDescriptors, (current) => {
          const next = new Map(current);
          next.set(input.expectedEnvironmentId, {
            httpBaseUrl: input.httpBaseUrl,
            descriptor,
            validatedAtEpochMs: now,
          });
          return next;
        });
      }
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (token: TokenStore.RemoteDpopAccessToken, timeoutMs?: number) {
      const ticketProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(token.endpoint.httpBaseUrl, "/api/auth/websocket-ticket"),
          accessToken: token.accessToken,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the websocket authorization proof.",
              }),
          ),
        );
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: token.endpoint.wsBaseUrl,
        httpBaseUrl: token.endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        dpopProof: ticketProof,
        clientMetadata: presentation.metadata,
        connectionMethod: "relay",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
  );

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["expectedEnvironmentId"];
      readonly obtainBootstrap: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["obtainBootstrap"];
    }) {
      const thumbprint = yield* signer.thumbprint.pipe(
        Effect.mapError(
          () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Could not load the environment authorization key.",
            }),
        ),
        Effect.withSpan("environment.authorization.dpopKey.resolve"),
      );
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* tokenStore
        .get(input.expectedEnvironmentId)
        .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
      if (
        Option.isSome(cached) &&
        cached.value.environmentId === input.expectedEnvironmentId &&
        cached.value.dpopThumbprint === thumbprint &&
        cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS
      ) {
        yield* Effect.annotateCurrentSpan({
          "connection.remote_token_cache": "hit",
        });
        let cachedSocket = yield* createDpopSocketUrl(
          cached.value,
          CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        ).pipe(Effect.result);
        if (
          Result.isFailure(cachedSocket) &&
          cachedSocket.failure._tag !== "ConnectionBlockedError" &&
          !isCachedTokenRejection(cachedSocket.failure)
        ) {
          // One slow round trip (a hibernated relay session, a waking laptop)
          // is not evidence against the token; retry once with the patient
          // default budget before giving up on the attempt.
          yield* Effect.annotateCurrentSpan({
            "connection.remote_token_cache.retry": true,
          });
          cachedSocket = yield* createDpopSocketUrl(cached.value).pipe(Effect.result);
        }
        if (Result.isSuccess(cachedSocket)) {
          return {
            environmentId: cached.value.environmentId,
            label: cached.value.label,
            httpBaseUrl: cached.value.endpoint.httpBaseUrl,
            socketUrl: cachedSocket.success,
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: cached.value.accessToken,
              expiresAtEpochMs: cached.value.expiresAtEpochMs,
            },
          };
        }
        if (isCachedTokenRejection(cachedSocket.failure)) {
          yield* tokenStore
            .remove(input.expectedEnvironmentId)
            .pipe(Effect.withSpan("environment.authorization.accessToken.remove"));
        } else {
          // The token is still presumed good; fail the attempt and let the
          // supervisor retry instead of paying the full cold connect.
          return yield* mapDpopSocketError(cachedSocket.failure);
        }
      }

      yield* Effect.annotateCurrentSpan({
        "connection.remote_token_cache": "miss",
      });
      const bootstrap = yield* input.obtainBootstrap;
      // The relay verified this descriptor against the environment's signature,
      // so trust it and skip a round trip back through the same tunnel.
      const descriptor =
        bootstrap.descriptor ??
        (yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.withSpan("environment.authorization.descriptor"),
        ));
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      // A bundled session skips the token-exchange and websocket-ticket round
      // trips entirely; the mint already bound the token to our proof key.
      if (bootstrap.session && oauthScopeSetEquals(bootstrap.session.scope, presentation.scopes)) {
        yield* Effect.annotateCurrentSpan({
          "connection.remote_bootstrap": "bundled_session",
        });
        const issuedAt = yield* Clock.currentTimeMillis;
        const token = new TokenStore.RemoteDpopAccessToken({
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          endpoint: bootstrap.endpoint,
          accessToken: bootstrap.session.accessToken,
          expiresAtEpochMs: issuedAt + bootstrap.session.expiresInSeconds * 1_000,
          dpopThumbprint: thumbprint,
        });
        const socketUrl = buildRemoteWebSocketConnectionUrl({
          wsBaseUrl: bootstrap.endpoint.wsBaseUrl,
          wsTicket: bootstrap.session.wsTicket,
          clientMetadata: presentation.metadata,
          connectionMethod: "relay",
        });
        yield* tokenStore
          .put(token)
          .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
        return {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
          socketUrl,
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: token.accessToken,
            expiresAtEpochMs: token.expiresAtEpochMs,
          },
        };
      }
      if (bootstrap.credential === undefined) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The relay bootstrap carried neither a credential nor a usable session.",
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        scopes: presentation.scopes,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteDpopEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      const token = new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
      const socketUrl = yield* createDpopSocketUrl(token).pipe(Effect.mapError(mapDpopSocketError));
      yield* tokenStore
        .put(token)
        .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: token.accessToken,
          expiresAtEpochMs: token.expiresAtEpochMs,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: (input) =>
      authorizeDpop(input).pipe(Effect.withSpan("environment.authorization")),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
