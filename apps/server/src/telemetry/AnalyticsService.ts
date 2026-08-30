/**
 * Anonymous PostHog telemetry service.
 *
 * @module AnalyticsService
 */
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { ClientOs, ProviderRuntimeEvent } from "@ras-code/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@ras-code/shared/hostProcess";
import { POSTHOG_MANAGED_PROXY_HOST, POSTHOG_PROJECT_TOKEN } from "@ras-code/shared/posthog";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { PostHog, type EventMessage, type FeatureFlagEvaluations } from "posthog-node";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";

export const AI_OBSERVABILITY_FLAG = "ras-code-ai-observability";
const FEATURE_FLAG_REFRESH_INTERVAL = "5 minutes";

export interface TelemetryCapture {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: Record<string, unknown>;
  readonly flags?: TelemetryFeatureFlags;
}

export interface TelemetryException {
  readonly error: Error;
  readonly distinctId: string;
  readonly properties: Record<string, unknown>;
}

export interface TelemetryMetric {
  readonly type: "count" | "gauge" | "histogram";
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface TelemetryLog {
  readonly body: string;
  readonly level: "info" | "warn" | "error";
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface TelemetryFeatureFlags {
  isEnabled(key: string, options?: { readonly defaultValue?: boolean }): boolean;
  only(keys: string[]): TelemetryFeatureFlags;
}

export interface TelemetryPostHogClient {
  capture(input: TelemetryCapture): void;
  captureAi(input: TelemetryCapture): string | undefined;
  captureException(error: Error, distinctId: string, properties: Record<string, unknown>): void;
  evaluateFlags(
    distinctId: string,
    options: {
      readonly flagKeys: string[];
      readonly personProperties: Record<string, unknown>;
      readonly disableGeoip?: boolean;
    },
  ): Promise<TelemetryFeatureFlags>;
  readonly metrics: {
    count(
      name: string,
      value?: number,
      options?: {
        readonly unit?: string;
        readonly attributes?: Record<string, string | number | boolean>;
      },
    ): void;
    gauge(
      name: string,
      value: number,
      options?: {
        readonly unit?: string;
        readonly attributes?: Record<string, string | number | boolean>;
      },
    ): void;
    histogram(
      name: string,
      value: number,
      options?: {
        readonly unit?: string;
        readonly attributes?: Record<string, string | number | boolean>;
      },
    ): void;
    flush(): Promise<void>;
  };
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface TelemetryLogSink {
  emit(log: TelemetryLog): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const noOpTelemetryLogSink: TelemetryLogSink = {
  emit: () => undefined,
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.string("RAS_CODE_POSTHOG_KEY").pipe(Config.withDefault(POSTHOG_PROJECT_TOKEN)),
  posthogHost: Config.string("RAS_CODE_POSTHOG_HOST").pipe(
    Config.withDefault(POSTHOG_MANAGED_PROXY_HOST),
  ),
  posthogLogsUrl: Config.string("RAS_CODE_POSTHOG_LOGS_URL").pipe(Config.option),
  enabled: Config.boolean("RAS_CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("RAS_CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("RAS_CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

interface TurnTelemetry {
  readonly startedAtMs?: number;
  readonly model?: string;
}

interface TokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
}

interface FeatureFlagState {
  readonly aiObservabilityEnabled: boolean;
  readonly flags?: TelemetryFeatureFlags;
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly enabled: boolean;
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly recordProviderRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly refreshFeatureFlags: Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("ras-code/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      enabled: false,
      record: () => Effect.void,
      recordProviderRuntimeEvent: () => Effect.void,
      refreshFeatureFlags: Effect.void,
      flush: Effect.void,
    }),
  );
}

export function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

function wrapPostHogClient(client: PostHog): TelemetryPostHogClient {
  return {
    capture: ({ flags, ...input }) =>
      client.capture({
        ...input,
        ...(flags === undefined ? {} : { flags: flags as FeatureFlagEvaluations }),
      }),
    captureAi: ({ flags, ...input }) =>
      client.captureAi({
        ...input,
        ...(flags === undefined ? {} : { flags: flags as FeatureFlagEvaluations }),
      }),
    captureException: (error, distinctId, properties) =>
      client.captureException(error, distinctId, properties),
    evaluateFlags: (distinctId, options) => client.evaluateFlags(distinctId, options),
    metrics: client.metrics,
    flush: () => client.flush(),
    shutdown: (timeoutMs) => client.shutdown(timeoutMs),
  };
}

function deriveLogsUrl(posthogHost: string): string {
  const url = new URL(posthogHost);
  url.pathname = "/i/v1/logs";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function makeTelemetryLogSink(input: {
  readonly url: string;
  readonly token: string;
  readonly serverMode: string;
}): TelemetryLogSink {
  const exporter = new OTLPLogExporter({
    url: input.url,
    headers: { Authorization: `Bearer ${input.token}` },
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "ras-code-server",
      "service.version": packageJson.version,
      "service.mode": input.serverMode,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        maxQueueSize: 1_000,
        maxExportBatchSize: 100,
      }),
    ],
  });
  const logger = provider.getLogger("ras-code.telemetry", packageJson.version);
  const severity = {
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  } as const;

  return {
    emit: (log) =>
      logger.emit({
        eventName: log.body.replaceAll(" ", "."),
        body: log.body,
        severityText: log.level.toUpperCase(),
        severityNumber: severity[log.level],
        ...(log.attributes === undefined ? {} : { attributes: log.attributes as LogAttributes }),
      }),
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readFirstNumber(
  records: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = finiteNonNegative(record[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function normalizeTokenUsage(...values: ReadonlyArray<unknown>): TokenUsage {
  const records = values.map(asRecord);
  const inputTokens = readFirstNumber(records, ["lastInputTokens", "inputTokens", "input_tokens"]);
  const cachedInputTokens = readFirstNumber(records, [
    "lastCachedInputTokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
  ]);
  const outputTokens = readFirstNumber(records, [
    "lastOutputTokens",
    "outputTokens",
    "output_tokens",
  ]);
  const durationMs = readFirstNumber(records, ["durationMs", "duration_ms"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function turnKey(event: ProviderRuntimeEvent): string {
  return `${event.provider}:${event.threadId}:${event.turnId ?? "active"}`;
}

function threadKey(event: ProviderRuntimeEvent): string {
  return `${event.provider}:${event.threadId}`;
}

function compactProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function setBoundedMapEntry<K, V>(
  current: ReadonlyMap<K, V>,
  key: K,
  value: V,
  maxSize: number,
): Map<K, V> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  while (next.size > Math.max(0, maxSize)) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

function basename(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  return path.split(/[\\/]/).at(-1);
}

function redactExceptionFrame(value: unknown): Record<string, unknown> {
  const frame = asRecord(value) ?? {};
  return compactProperties({
    platform: frame.platform,
    filename: basename(frame.filename ?? frame.abs_path),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    chunk_id: frame.chunk_id,
  });
}

export function redactExceptionEvent(event: EventMessage | null): EventMessage | null {
  if (event?.event !== "$exception" || event.properties === undefined) return event;
  const exceptionList = event.properties.$exception_list;
  const redactedExceptionList = Array.isArray(exceptionList)
    ? exceptionList.map((value) => {
        const exception = asRecord(value) ?? {};
        const mechanism = asRecord(exception.mechanism);
        const stacktrace = asRecord(exception.stacktrace);
        const frames = stacktrace?.frames;
        return compactProperties({
          type: exception.type,
          value: "Redacted exception",
          mechanism:
            mechanism === undefined
              ? undefined
              : compactProperties({
                  handled: mechanism.handled,
                  type: mechanism.type,
                  synthetic: mechanism.synthetic,
                }),
          stacktrace:
            stacktrace === undefined
              ? undefined
              : {
                  type: "raw",
                  ...(Array.isArray(frames) ? { frames: frames.map(redactExceptionFrame) } : {}),
                },
        });
      })
    : exceptionList;

  return {
    ...event,
    properties: {
      ...event.properties,
      $exception_message: "Redacted exception",
      $exception_list: redactedExceptionList,
    },
  };
}

export const make = (options?: {
  readonly client?: TelemetryPostHogClient;
  readonly logSink?: TelemetryLogSink;
}) =>
  Effect.gen(function* () {
    const telemetryConfig = yield* TelemetryEnvConfig;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const identifier = yield* getTelemetryIdentifier;
    const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
    const hostPlatform = yield* HostProcessPlatform;
    const hostArchitecture = yield* HostProcessArchitecture;
    const disabled = !telemetryConfig.enabled || identifier === null;
    const commonProperties = compactProperties({
      $process_person_profile: false,
      platform: hostPlatform,
      wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
      arch: hostArchitecture,
      rasCodeVersion: packageJson.version,
      clientType,
      serverOs: serverOsFromNodePlatform(hostPlatform),
      serverArch: hostArchitecture,
      serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
      serverAppVersion: packageJson.version,
      serverMode: serverConfig.mode,
    });
    const client =
      options?.client ??
      wrapPostHogClient(
        new PostHog(telemetryConfig.posthogKey, {
          host: telemetryConfig.posthogHost,
          disabled,
          flushAt: telemetryConfig.flushBatchSize,
          flushInterval: 1_000,
          maxQueueSize: telemetryConfig.maxBufferedEvents,
          disableGeoip: true,
          enableExceptionAutocapture: true,
          enableFullAiCapture: false,
          before_send: redactExceptionEvent,
          metrics: {
            serviceName: "ras-code-server",
            serviceVersion: packageJson.version,
            resourceAttributes: { "service.mode": serverConfig.mode },
          },
        }),
      );
    const logSink =
      options?.logSink ??
      (disabled
        ? noOpTelemetryLogSink
        : makeTelemetryLogSink({
            url:
              Option.getOrUndefined(telemetryConfig.posthogLogsUrl) ??
              deriveLogsUrl(telemetryConfig.posthogHost),
            token: telemetryConfig.posthogKey,
            serverMode: serverConfig.mode,
          }));
    const activeTurns = yield* Ref.make(new Map<string, TurnTelemetry>());
    const latestUsage = yield* Ref.make(new Map<string, TokenUsage>());
    const featureFlagState = yield* Ref.make<FeatureFlagState>({
      aiObservabilityEnabled: true,
    });

    const bestEffort = (operation: string, effect: Effect.Effect<void>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Failed to ${operation} telemetry`, { cause }),
        ),
      );

    const refreshFeatureFlags = Effect.tryPromise(() =>
      disabled || identifier === null
        ? Promise.resolve(undefined)
        : client.evaluateFlags(identifier, {
            flagKeys: [AI_OBSERVABILITY_FLAG],
            personProperties: commonProperties,
            disableGeoip: true,
          }),
    ).pipe(
      Effect.flatMap((flags) =>
        flags === undefined
          ? Effect.void
          : Ref.set(featureFlagState, {
              aiObservabilityEnabled: flags.isEnabled(AI_OBSERVABILITY_FLAG, {
                defaultValue: true,
              }),
              flags,
            }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to refresh PostHog feature flags", { cause }),
      ),
    );

    const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
      (event, properties) =>
        disabled || identifier === null
          ? Effect.void
          : bestEffort(
              "capture product",
              Effect.sync(() =>
                client.capture({
                  distinctId: identifier,
                  event,
                  properties: compactProperties({ ...commonProperties, ...properties }),
                }),
              ),
            ),
    );

    const recordMetric = (metric: TelemetryMetric) =>
      bestEffort(
        "capture metric",
        Effect.sync(() => {
          const options = {
            ...(metric.unit === undefined ? {} : { unit: metric.unit }),
            ...(metric.attributes === undefined ? {} : { attributes: metric.attributes }),
          };
          client.metrics[metric.type](metric.name, metric.value, options);
        }),
      );

    const recordLog = (log: TelemetryLog) =>
      bestEffort(
        "capture log",
        Effect.sync(() => logSink.emit(log)),
      );

    const recordException = (error: Error, properties: Readonly<Record<string, unknown>>) =>
      disabled || identifier === null
        ? Effect.void
        : bestEffort(
            "capture exception",
            Effect.sync(() => {
              client.captureException(
                error,
                identifier,
                compactProperties({ ...commonProperties, ...properties }),
              );
            }),
          );

    const recordTerminalTurn = (
      event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
    ) =>
      Effect.gen(function* () {
        if (disabled || identifier === null) return;
        const turn = (yield* Ref.get(activeTurns)).get(turnKey(event));
        const usage = normalizeTokenUsage(
          event.type === "turn.completed" ? event.payload.usage : undefined,
          event.type === "turn.completed" ? event.payload.modelUsage : undefined,
          (yield* Ref.get(latestUsage)).get(threadKey(event)),
        );
        const completedAtMs = Date.parse(event.createdAt);
        const elapsedMs =
          turn?.startedAtMs !== undefined && Number.isFinite(completedAtMs)
            ? Math.max(0, completedAtMs - turn.startedAtMs)
            : undefined;
        const durationMs = usage.durationMs ?? elapsedMs;
        const provider = String(event.provider);
        const model = turn?.model ?? "unknown";
        const state = event.type === "turn.completed" ? event.payload.state : "cancelled";
        const isError = state === "failed";
        const flags = yield* Ref.get(featureFlagState);

        if (flags.aiObservabilityEnabled) {
          yield* bestEffort(
            "capture AI generation",
            Effect.sync(() =>
              client.captureAi({
                distinctId: identifier,
                event: "$ai_generation",
                properties: compactProperties({
                  ...commonProperties,
                  $ai_trace_id: String(event.turnId ?? event.eventId),
                  $ai_session_id: String(event.threadId),
                  $ai_span_id: String(event.eventId),
                  $ai_span_name: "provider.turn",
                  $ai_model: model,
                  $ai_provider: provider,
                  $ai_input_tokens: usage.inputTokens,
                  $ai_cache_read_input_tokens: usage.cachedInputTokens,
                  $ai_output_tokens: usage.outputTokens,
                  $ai_latency: durationMs === undefined ? undefined : durationMs / 1_000,
                  $ai_total_cost_usd:
                    event.type === "turn.completed" ? event.payload.totalCostUsd : undefined,
                  $ai_stream: true,
                  $ai_is_error: isError,
                  $ai_stop_reason: state,
                }),
                ...(flags.flags === undefined
                  ? {}
                  : { flags: flags.flags.only([AI_OBSERVABILITY_FLAG]) }),
              }),
            ),
          );
        }

        yield* recordMetric({
          type: "count",
          name: "ras_code.provider.turns",
          value: 1,
          attributes: { provider, state },
        });
        if (durationMs !== undefined) {
          yield* recordMetric({
            type: "histogram",
            name: "ras_code.provider.turn.duration",
            value: durationMs,
            unit: "ms",
            attributes: { provider, state },
          });
        }
        for (const [direction, value] of [
          ["input", usage.inputTokens],
          ["cache_read", usage.cachedInputTokens],
          ["output", usage.outputTokens],
        ] as const) {
          if (value !== undefined) {
            yield* recordMetric({
              type: "count",
              name: "ras_code.provider.tokens",
              value,
              attributes: { provider, direction },
            });
          }
        }
        const totalCostUsd =
          event.type === "turn.completed" ? event.payload.totalCostUsd : undefined;
        if (totalCostUsd !== undefined) {
          yield* recordMetric({
            type: "histogram",
            name: "ras_code.provider.turn.cost",
            value: totalCostUsd,
            unit: "USD",
            attributes: { provider, state },
          });
        }

        yield* recordLog({
          body:
            event.type === "turn.aborted"
              ? "provider turn aborted"
              : isError
                ? "provider turn failed"
                : "provider turn completed",
          level: isError ? "error" : "info",
          attributes: compactProperties({
            provider,
            state,
            model,
            durationMs,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            posthogDistinctId: identifier,
          }) as Record<string, string | number | boolean>,
        });
        if (isError) {
          yield* recordException(new Error("Provider turn failed"), {
            operation: "provider.turn",
            provider,
            state,
            model,
          });
        }
        yield* Ref.update(activeTurns, (turns) => {
          const next = new Map(turns);
          next.delete(turnKey(event));
          return next;
        });
        yield* Ref.update(latestUsage, (usageByThread) => {
          const next = new Map(usageByThread);
          next.delete(threadKey(event));
          return next;
        });
      });

    const recordProviderRuntimeEvent: AnalyticsService["Service"]["recordProviderRuntimeEvent"] =
      Effect.fn("AnalyticsService.recordProviderRuntimeEvent")(function* (event) {
        if (disabled || identifier === null) return;
        switch (event.type) {
          case "turn.started": {
            const startedAtMs = Date.parse(event.createdAt);
            yield* Ref.update(activeTurns, (turns) =>
              setBoundedMapEntry(
                turns,
                turnKey(event),
                {
                  ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
                  ...(event.payload.model === undefined ? {} : { model: event.payload.model }),
                },
                telemetryConfig.maxBufferedEvents,
              ),
            );
            break;
          }
          case "thread.token-usage.updated":
            yield* Ref.update(latestUsage, (usageByThread) =>
              setBoundedMapEntry(
                usageByThread,
                threadKey(event),
                normalizeTokenUsage(event.payload.usage),
                telemetryConfig.maxBufferedEvents,
              ),
            );
            break;
          case "turn.completed":
          case "turn.aborted":
            yield* recordTerminalTurn(event);
            break;
          case "runtime.error":
            yield* recordException(new Error("Provider runtime error"), {
              operation: "provider.runtime",
              provider: event.provider,
              errorClass: event.payload.class,
            });
            yield* recordLog({
              body: "provider runtime error",
              level: "error",
              attributes: compactProperties({
                provider: event.provider,
                errorClass: event.payload.class,
                posthogDistinctId: identifier ?? undefined,
              }) as Record<string, string | number | boolean>,
            });
            break;
        }
      });

    const flush = Effect.tryPromise(() =>
      Promise.all([client.flush(), client.metrics.flush(), logSink.flush()]).then(() => undefined),
    ).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

    yield* refreshFeatureFlags.pipe(
      Effect.repeat(Schedule.spaced(FEATURE_FLAG_REFRESH_INTERVAL)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() =>
        Promise.allSettled([client.shutdown(5_000), logSink.shutdown()]).then(() => undefined),
      ).pipe(Effect.ignore),
    );

    return AnalyticsService.of({
      enabled: !disabled,
      record,
      recordProviderRuntimeEvent,
      refreshFeatureFlags,
      flush,
    });
  });

export const layer = Layer.effect(AnalyticsService, make());

export const layerTest = AnalyticsService.layerTest;
