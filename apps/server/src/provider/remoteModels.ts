/**
 * Remote model catalog lookup for gateway-backed provider instances.
 *
 * A provider instance can be pointed at a gateway by setting one of the
 * gateway base-URL variables plus a key in its environment. Such a gateway
 * exposes its catalog at `GET {baseUrl}/v1/models` in the OpenRouter envelope
 * (`{ data: [{ id, name? }] }`), which is not something the driver's own probe
 * discovers — the CLI only knows the models its vendor ships.
 *
 * Read straight from settings rather than the running instance: the answer
 * must be available while the user is still configuring the instance, before
 * any session has started.
 *
 * @module remoteModels
 */
import {
  ProviderListRemoteModelsError,
  type ProviderInstanceId,
  type ProviderListRemoteModelsResult,
  type ProviderRemoteModel,
} from "@ras-code/contracts";
import {
  ANTHROPIC_API_KEY_VARIABLE,
  gatewayBaseUrl,
  gatewayKey,
  type GatewayEnvironmentVariable,
  GATEWAY_BASE_URL_VARIABLES,
  GATEWAY_KEY_VARIABLES,
} from "@ras-code/shared/posthogGateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";

const REQUEST_TIMEOUT_MS = 10_000;

const parseRemoteModels = (body: unknown): ReadonlyArray<ProviderRemoteModel> | undefined => {
  if (!Predicate.isObject(body)) {
    return undefined;
  }
  const data = (body as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const models: Array<ProviderRemoteModel> = [];
  for (const entry of data) {
    if (!Predicate.isObject(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = Predicate.isString(record.id) ? record.id.trim() : "";
    if (id.length === 0) {
      continue;
    }
    const name = Predicate.isString(record.name) ? record.name.trim() : "";
    models.push({ id, name: name.length > 0 ? name : null });
  }
  return models;
};

/**
 * Read a gateway's catalog directly from a resolved origin and key.
 *
 * Split out from `listRemoteModels` so a driver that already knows its own
 * gateway coordinates does not have to round-trip through server settings to
 * ask for them.
 */
export const fetchGatewayModels = Effect.fn("fetchGatewayModels")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly baseUrl: string;
  readonly key: GatewayEnvironmentVariable;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${input.baseUrl.replace(/\/+$/, "")}/v1/models`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${input.key.value}`,
      // Gateways that authenticate the Anthropic way read the key header
      // instead; sending both keeps one call working against either.
      ...(input.key.name === ANTHROPIC_API_KEY_VARIABLE ? { "x-api-key": input.key.value } : {}),
    }),
  );

  const body = yield* httpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(REQUEST_TIMEOUT_MS),
    Effect.mapError(
      () =>
        new ProviderListRemoteModelsError({
          instanceId: input.instanceId,
          reason: "request-failed",
          detail: `Request to ${input.baseUrl} failed.`,
        }),
    ),
  );

  const models = parseRemoteModels(body);
  if (models === undefined) {
    return yield* new ProviderListRemoteModelsError({
      instanceId: input.instanceId,
      reason: "invalid-response",
      detail: `${input.baseUrl} did not return a model list.`,
    });
  }
  return models;
});

/**
 * List the models a provider instance's configured gateway advertises.
 *
 * Fails with a typed reason so the client can tell "you have not configured a
 * base URL" apart from "the gateway rejected the token".
 */
export const listRemoteModels = Effect.fn("listRemoteModels")(function* (
  instanceId: ProviderInstanceId,
) {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError(
      () =>
        new ProviderListRemoteModelsError({
          instanceId,
          reason: "instance-not-found",
          detail: "Server settings could not be read.",
        }),
    ),
  );
  const instance = settings.providerInstances[instanceId];
  if (instance === undefined) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "instance-not-found",
    });
  }

  const baseUrl = gatewayBaseUrl(instance.environment);
  if (baseUrl.length === 0) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "missing-base-url",
      detail: `Set ${GATEWAY_BASE_URL_VARIABLES.join(" or ")} on this instance to list its remote models.`,
    });
  }

  const key = gatewayKey(instance.environment);
  if (key === undefined) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "missing-auth",
      detail: `Set ${GATEWAY_KEY_VARIABLES.join(" or ")} on this instance.`,
    });
  }

  const models = yield* fetchGatewayModels({ instanceId, baseUrl, key });
  return { models } satisfies ProviderListRemoteModelsResult;
});
