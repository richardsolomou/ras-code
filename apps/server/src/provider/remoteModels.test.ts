import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ras-code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import { listRemoteModels } from "./remoteModels.ts";

const INSTANCE = ProviderInstanceId.make("claude_gateway");
const BASE_URL = "https://ai-gateway.us.posthog.com";

const instanceSettings = (
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => ({
  providerInstances: {
    [INSTANCE]: {
      driver: "claudeAgent",
      environment: environment.map((variable) => ({ ...variable, sensitive: false })),
    },
  },
});

const gatewayEnvironment = [
  { name: "ANTHROPIC_BASE_URL", value: BASE_URL },
  { name: "ANTHROPIC_AUTH_TOKEN", value: "phs_test_key" },
];

type Handler = (request: HttpClientRequest.HttpClientRequest) => Response;

const layers = (input: {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly handler?: Handler;
}) =>
  Layer.mergeAll(
    ServerSettings.layerTest(input.settings ?? {}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            input.handler?.(request) ?? new Response("{}", { status: 200 }),
          ),
        ),
      ),
    ),
  );

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listRemoteModels", () => {
  it.effect("parses the OpenRouter-shaped catalog into ids and names", () =>
    Effect.gen(function* () {
      const result = yield* listRemoteModels(INSTANCE);
      assert.deepStrictEqual(result.models, [
        { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "anthropic/claude-opus-4.1", name: null },
      ]);
    }).pipe(
      Effect.provide(
        layers({
          settings: instanceSettings(gatewayEnvironment),
          handler: () =>
            jsonResponse({
              data: [
                { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
                { id: "anthropic/claude-opus-4.1" },
                { id: "   " },
              ],
            }),
        }),
      ),
    ),
  );

  it.effect("requests /v1/models with a bearer token", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
      yield* listRemoteModels(INSTANCE).pipe(
        Effect.provide(
          layers({
            settings: instanceSettings(gatewayEnvironment),
            handler: (request) => {
              seen.push({
                url: request.url,
                authorization: request.headers.authorization,
              });
              return jsonResponse({ data: [] });
            },
          }),
        ),
      );
      assert.deepStrictEqual(seen, [
        { url: `${BASE_URL}/v1/models`, authorization: "Bearer phs_test_key" },
      ]);
    }),
  );

  it.effect("sends the api key as x-api-key when no auth token is configured", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = [];
      yield* listRemoteModels(INSTANCE).pipe(
        Effect.provide(
          layers({
            settings: instanceSettings([
              { name: "ANTHROPIC_BASE_URL", value: BASE_URL },
              { name: "ANTHROPIC_API_KEY", value: "sk-test" },
            ]),
            handler: (request) => {
              seen.push(request.headers["x-api-key"]);
              return jsonResponse({ data: [] });
            },
          }),
        ),
      );
      assert.deepStrictEqual(seen, ["sk-test"]);
    }),
  );

  it.effect("reports an unknown instance", () =>
    listRemoteModels(ProviderInstanceId.make("nope")).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.reason, "instance-not-found");
      }),
      Effect.provide(layers({ settings: instanceSettings(gatewayEnvironment) })),
    ),
  );

  it.effect("reports a missing base url", () =>
    listRemoteModels(INSTANCE).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.reason, "missing-base-url");
      }),
      Effect.provide(
        layers({
          settings: instanceSettings([{ name: "ANTHROPIC_AUTH_TOKEN", value: "phs_test_key" }]),
        }),
      ),
    ),
  );

  it.effect("reports missing auth", () =>
    listRemoteModels(INSTANCE).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.reason, "missing-auth");
      }),
      Effect.provide(
        layers({ settings: instanceSettings([{ name: "ANTHROPIC_BASE_URL", value: BASE_URL }]) }),
      ),
    ),
  );

  it.effect("reports a rejected request", () =>
    listRemoteModels(INSTANCE).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.reason, "request-failed");
      }),
      Effect.provide(
        layers({
          settings: instanceSettings(gatewayEnvironment),
          handler: () => jsonResponse({ error: "unauthorized" }, 401),
        }),
      ),
    ),
  );

  it.effect("reports a response that carries no model list", () =>
    listRemoteModels(INSTANCE).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.reason, "invalid-response");
      }),
      Effect.provide(
        layers({
          settings: instanceSettings(gatewayEnvironment),
          handler: () => jsonResponse({ models: [] }),
        }),
      ),
    ),
  );
});
