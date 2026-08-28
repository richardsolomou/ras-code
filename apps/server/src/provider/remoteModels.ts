/**
 * Remote model catalog lookup for gateway-backed provider instances.
 *
 * A provider instance can be pointed at an Anthropic-shaped proxy by setting
 * `ANTHROPIC_BASE_URL` plus a bearer token in its environment. Such a gateway
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
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";

const REQUEST_TIMEOUT_MS = 10_000;

const BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL";
const AUTH_TOKEN_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
const API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

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
 * List the models a provider instance's configured gateway advertises.
 *
 * Fails with a typed reason so the client can tell "you have not configured a
 * base URL" apart from "the gateway rejected the token".
 */
export const listRemoteModels = Effect.fn("listRemoteModels")(function* (
  instanceId: ProviderInstanceId,
) {
  const httpClient = yield* HttpClient.HttpClient;
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

  const environment = new Map(
    (instance.environment ?? []).map((variable) => [variable.name, variable.value.trim()] as const),
  );
  const baseUrl = environment.get(BASE_URL_VARIABLE) ?? "";
  if (baseUrl.length === 0) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "missing-base-url",
      detail: `Set ${BASE_URL_VARIABLE} on this instance to list its remote models.`,
    });
  }

  const authToken = environment.get(AUTH_TOKEN_VARIABLE) ?? "";
  const apiKey = environment.get(API_KEY_VARIABLE) ?? "";
  if (authToken.length === 0 && apiKey.length === 0) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "missing-auth",
      detail: `Set ${AUTH_TOKEN_VARIABLE} or ${API_KEY_VARIABLE} on this instance.`,
    });
  }

  const bearer = authToken.length > 0 ? authToken : apiKey;
  const request = HttpClientRequest.get(`${baseUrl.replace(/\/+$/, "")}/v1/models`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${bearer}`,
      // Gateways that authenticate the Anthropic way read the key header
      // instead; sending both keeps one call working against either.
      ...(authToken.length === 0 ? { "x-api-key": apiKey } : {}),
    }),
  );

  const body = yield* httpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(REQUEST_TIMEOUT_MS),
    Effect.mapError(
      () =>
        new ProviderListRemoteModelsError({
          instanceId,
          reason: "request-failed",
          detail: `Request to ${baseUrl} failed.`,
        }),
    ),
  );

  const models = parseRemoteModels(body);
  if (models === undefined) {
    return yield* new ProviderListRemoteModelsError({
      instanceId,
      reason: "invalid-response",
      detail: `${baseUrl} did not return a model list.`,
    });
  }

  return { models } satisfies ProviderListRemoteModelsResult;
});
