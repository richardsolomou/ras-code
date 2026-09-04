import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeUtil from "node:util";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const makeTelemetryPostHogClientTest = (input?: {
  readonly captures?: AnalyticsService.TelemetryCapture[];
  readonly aiCaptures?: AnalyticsService.TelemetryCapture[];
  readonly exceptions?: AnalyticsService.TelemetryException[];
  readonly metrics?: AnalyticsService.TelemetryMetric[];
  readonly featureFlags?: Readonly<Record<string, boolean>>;
}): AnalyticsService.TelemetryPostHogClient => {
  const flags: AnalyticsService.TelemetryFeatureFlags = {
    isEnabled: (key, options) => input?.featureFlags?.[key] ?? options?.defaultValue ?? false,
    only: () => flags,
  };
  const recordMetric =
    (type: AnalyticsService.TelemetryMetric["type"]) =>
    (
      name: string,
      value = 1,
      options?: {
        readonly unit?: string;
        readonly attributes?: Record<string, string | number | boolean>;
      },
    ) => {
      input?.metrics?.push({ type, name, value, ...options });
    };

  return {
    capture: (capture) => input?.captures?.push(capture),
    captureAi: (capture) => {
      input?.aiCaptures?.push(capture);
      return undefined;
    },
    captureException: (error, distinctId, properties) =>
      input?.exceptions?.push({ error, distinctId, properties }),
    evaluateFlags: () => Promise.resolve(flags),
    metrics: {
      count: recordMetric("count"),
      gauge: recordMetric("gauge"),
      histogram: recordMetric("histogram"),
      flush: () => Promise.resolve(),
    },
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
};

const makeTelemetryLogSinkTest = (
  logs: AnalyticsService.TelemetryLog[],
): AnalyticsService.TelemetryLogSink => ({
  emit: (log) => logs.push(log),
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
});

const eventId = (value: string) => EventId.make(value);
const provider = (value: string) => ProviderDriverKind.make(value);
const threadId = (value: string) => ThreadId.make(value);
const turnId = (value: string) => TurnId.make(value);

const makeRuntimeLayer = (
  client: AnalyticsService.TelemetryPostHogClient,
  logSink: AnalyticsService.TelemetryLogSink = AnalyticsService.noOpTelemetryLogSink,
  config?: {
    readonly posthogHost?: string;
    readonly useConfiguredLogSink?: boolean;
  },
) => {
  const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "ras-code-telemetry-base-",
  });
  const telemetryLayer = Layer.effect(
    AnalyticsService.AnalyticsService,
    AnalyticsService.make(config?.useConfiguredLogSink ? { client } : { client, logSink }),
  ).pipe(Layer.provideMerge(serverConfigLayer));

  return telemetryLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RAS_CODE_TELEMETRY_ENABLED: true,
          RAS_CODE_POSTHOG_KEY: "phc_test_key",
          RAS_CODE_POSTHOG_HOST: config?.posthogHost ?? "https://example.invalid",
          RAS_CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "linux"),
        Layer.succeed(HostProcessArchitecture, "arm64"),
      ),
    ),
  );
};

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("records product events with anonymous server properties", () =>
    Effect.gen(function* () {
      const captures: AnalyticsService.TelemetryCapture[] = [];
      const client = makeTelemetryPostHogClientTest({ captures });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("client.turn.requested", { surface: "web" });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(captures.length, 1);
      assert.equal(captures[0]?.event, "client.turn.requested");
      assert.deepInclude(captures[0]?.properties ?? {}, {
        surface: "web",
        $process_person_profile: false,
        clientType: "cli-web-client",
        serverOs: "Linux",
        serverArch: "arm64",
        serverMode: "web",
      });
    }),
  );

  it.effect("does not fail application work when telemetry capture throws", () =>
    Effect.gen(function* () {
      const client = makeTelemetryPostHogClientTest();
      client.capture = () => {
        throw new Error("transport unavailable");
      };

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("client.connected");
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.isTrue(true);
    }),
  );

  it.effect("starts with log capture disabled when the PostHog host is invalid", () =>
    Effect.gen(function* () {
      const client = makeTelemetryPostHogClientTest();
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        assert.isTrue(analytics.enabled);
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          makeRuntimeLayer(client, AnalyticsService.noOpTelemetryLogSink, {
            posthogHost: "not a URL",
            useConfiguredLogSink: true,
          }),
        ),
      );
    }),
  );

  it.effect("captures prompt-free AI generations when provider turns complete", () =>
    Effect.gen(function* () {
      const aiCaptures: AnalyticsService.TelemetryCapture[] = [];
      const metrics: AnalyticsService.TelemetryMetric[] = [];
      const logs: AnalyticsService.TelemetryLog[] = [];
      const client = makeTelemetryPostHogClientTest({ aiCaptures, metrics });
      const logSink = makeTelemetryLogSinkTest(logs);

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-start"),
          provider: provider("codex"),
          threadId: threadId("thread-1"),
          turnId: turnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "turn.started",
          payload: { model: "gpt-5.6" },
        });
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-usage"),
          provider: provider("codex"),
          threadId: threadId("thread-1"),
          turnId: turnId("turn-1"),
          createdAt: "2026-01-01T00:00:01.000Z",
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: 17,
              lastInputTokens: 11,
              lastCachedInputTokens: 4,
              lastOutputTokens: 6,
            },
          },
        });
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-complete"),
          provider: provider("codex"),
          threadId: threadId("thread-1"),
          turnId: turnId("turn-1"),
          createdAt: "2026-01-01T00:00:02.500Z",
          type: "turn.completed",
          payload: { state: "completed", totalCostUsd: 0.03 },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client, logSink)));

      assert.equal(aiCaptures.length, 1);
      assert.deepInclude(aiCaptures[0]?.properties ?? {}, {
        $ai_trace_id: "turn-1",
        $ai_session_id: "thread-1",
        $ai_model: "gpt-5.6",
        $ai_provider: "codex",
        $ai_input_tokens: 11,
        $ai_cache_read_input_tokens: 4,
        $ai_output_tokens: 6,
        $ai_latency: 2.5,
        $ai_total_cost_usd: 0.03,
        $ai_stream: true,
        $ai_is_error: false,
      });
      assert.notProperty(aiCaptures[0]?.properties ?? {}, "$ai_input");
      assert.notProperty(aiCaptures[0]?.properties ?? {}, "$ai_output_choices");
      assert.equal(
        metrics.some((metric) => metric.name === "ras_code.provider.turn.duration"),
        true,
      );
      assert.equal(logs[0]?.body, "provider turn completed");
    }),
  );

  it.effect("captures failed provider turns as exceptions without provider error text", () =>
    Effect.gen(function* () {
      const exceptions: AnalyticsService.TelemetryException[] = [];
      const client = makeTelemetryPostHogClientTest({ exceptions });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-failed"),
          provider: provider("claude"),
          threadId: threadId("thread-2"),
          turnId: turnId("turn-2"),
          createdAt: "2026-01-01T00:00:02.500Z",
          type: "turn.completed",
          payload: {
            state: "failed",
            errorMessage: "private prompt and token phx_secret",
          },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(exceptions.length, 1);
      assert.equal(exceptions[0]?.error.message, "Provider turn failed");
      assert.equal(
        exceptions[0]?.properties?.$exception_fingerprint,
        "ras-code:provider.turn:claude",
      );
      assert.equal(exceptions[0]?.properties?.$issue_name, "Provider turn failed (claude)");
      const capturedText = [
        exceptions[0]?.error.message,
        ...Object.values(exceptions[0]?.properties ?? {}).map(String),
      ].join("\n");
      assert.notInclude(capturedText, "private prompt");
      assert.notInclude(capturedText, "phx_secret");
    }),
  );

  it.effect("captures a Codex failure once when runtime.error and the failed turn both fire", () =>
    Effect.gen(function* () {
      const exceptions: AnalyticsService.TelemetryException[] = [];
      const client = makeTelemetryPostHogClientTest({ exceptions });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-start"),
          provider: provider("codex"),
          threadId: threadId("thread-5"),
          turnId: turnId("turn-5"),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "turn.started",
          payload: { model: "gpt-5.6" },
        });
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-error"),
          provider: provider("codex"),
          threadId: threadId("thread-5"),
          turnId: turnId("turn-5"),
          createdAt: "2026-01-01T00:00:01.000Z",
          type: "runtime.error",
          payload: {
            message: "gateway 500 from model zai-org/glm-5.3-flash",
            class: "provider_error",
          },
        });
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-failed"),
          provider: provider("codex"),
          threadId: threadId("thread-5"),
          turnId: turnId("turn-5"),
          createdAt: "2026-01-01T00:00:02.000Z",
          type: "turn.completed",
          payload: { state: "failed", errorMessage: "private prompt and token phx_secret" },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(exceptions.length, 1);
      assert.equal(
        exceptions[0]?.properties?.$exception_fingerprint,
        "ras-code:provider.runtime:codex:provider_error",
      );
      assert.equal(exceptions[0]?.properties?.$issue_name, "Provider runtime error (codex)");
      assert.equal(exceptions[0]?.properties?.model, "gpt-5.6");
      assert.equal(
        exceptions[0]?.properties?.errorMessage,
        "gateway 500 from model zai-org/glm-5.3-flash",
      );
      // The deduped failed turn sends no provider text of its own.
      assert.notInclude(NodeUtil.inspect(exceptions[0]), "private prompt");
      assert.notInclude(NodeUtil.inspect(exceptions[0]), "phx_secret");
    }),
  );

  it.effect("forwards the provider runtime error message as a triage property", () =>
    Effect.gen(function* () {
      const exceptions: AnalyticsService.TelemetryException[] = [];
      const client = makeTelemetryPostHogClientTest({ exceptions });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-error"),
          provider: provider("claude"),
          threadId: threadId("thread-6"),
          turnId: turnId("turn-6"),
          createdAt: "2026-01-01T00:00:01.000Z",
          type: "runtime.error",
          payload: { message: "connection reset by gateway", class: "transport_error" },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(exceptions.length, 1);
      assert.equal(exceptions[0]?.error.message, "Provider runtime error");
      assert.equal(exceptions[0]?.properties?.errorClass, "transport_error");
      assert.equal(exceptions[0]?.properties?.errorMessage, "connection reset by gateway");
      assert.equal(
        exceptions[0]?.properties?.$exception_fingerprint,
        "ras-code:provider.runtime:claude:transport_error",
      );
    }),
  );

  it.effect("uses the AI observability feature flag as a kill switch", () =>
    Effect.gen(function* () {
      const aiCaptures: AnalyticsService.TelemetryCapture[] = [];
      const client = makeTelemetryPostHogClientTest({
        aiCaptures,
        featureFlags: { [AnalyticsService.AI_OBSERVABILITY_FLAG]: false },
      });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.refreshFeatureFlags;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-complete"),
          provider: provider("opencode"),
          threadId: threadId("thread-3"),
          turnId: turnId("turn-3"),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "turn.completed",
          payload: { state: "completed" },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(aiCaptures.length, 0);
    }),
  );

  it.effect("captures aborted turns without the provider reason", () =>
    Effect.gen(function* () {
      const aiCaptures: AnalyticsService.TelemetryCapture[] = [];
      const client = makeTelemetryPostHogClientTest({ aiCaptures });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.recordProviderRuntimeEvent({
          eventId: eventId("event-aborted"),
          provider: provider("opencode"),
          threadId: threadId("thread-4"),
          turnId: turnId("turn-4"),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "turn.aborted",
          payload: { reason: "private prompt and token phx_secret" },
        });
      }).pipe(Effect.provide(makeRuntimeLayer(client)));

      assert.equal(aiCaptures.length, 1);
      assert.deepInclude(aiCaptures[0]?.properties ?? {}, {
        $ai_stop_reason: "cancelled",
        $ai_is_error: false,
      });
      assert.notInclude(NodeUtil.inspect(aiCaptures[0]), "private prompt");
      assert.notInclude(NodeUtil.inspect(aiCaptures[0]), "phx_secret");
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "ras-code-telemetry-disabled-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RAS_CODE_TELEMETRY_ENABLED: false,
          RAS_CODE_POSTHOG_KEY: "phc_test_key",
          RAS_CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});

it("redacts exception messages and local source context before capture", () => {
  const event = AnalyticsService.redactExceptionEvent({
    distinctId: "anonymous",
    event: "$exception",
    properties: {
      $exception_message: "private prompt and token phx_secret",
      $exception_list: [
        {
          type: "Error",
          value: "private prompt and token phx_secret",
          stacktrace: {
            type: "raw",
            frames: [
              {
                filename: "/Users/richard/project/private.ts",
                abs_path: "/Users/richard/project/private.ts",
                lineno: 42,
                context_line: "const token = 'phx_secret'",
                pre_context: ["private prompt"],
                post_context: ["send(token)"],
                vars: { token: "phx_secret" },
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(event?.properties?.$exception_message, "Redacted exception");
  const capturedText = NodeUtil.inspect(event, { depth: null });
  assert.notInclude(capturedText, "/Users/richard");
  assert.notInclude(capturedText, "private prompt");
  assert.notInclude(capturedText, "phx_secret");
  assert.include(capturedText, "private.ts");
  assert.include(capturedText, "42");
});
