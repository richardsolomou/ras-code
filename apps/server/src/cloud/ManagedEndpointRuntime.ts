import type { RelayManagedEndpointRuntimeConfig } from "@ras-code/contracts/relay";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";
import * as RasRelayConnector from "./RasRelayConnector.ts";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const readRuntimeConfig = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(bytes)) return null;
  return Option.getOrNull(decodeRuntimeConfig(bytesToString(bytes.value)));
});

export type CloudManagedEndpointRuntimeStatus =
  | { readonly status: "disabled" }
  | {
      readonly status: "failed";
      readonly providerKind: "ras_relay";
      readonly reason: string;
    }
  | { readonly status: "running"; readonly providerKind: "ras_relay" };

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
  }
>()("ras-code/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

export class RasRelayConnectorFactory extends Context.Service<
  RasRelayConnectorFactory,
  {
    readonly start: (
      config: RelayManagedEndpointRuntimeConfig,
    ) => Effect.Effect<
      RasRelayConnector.RasRelayConnectorHandle,
      RasRelayConnector.RasRelayConnectorStartError
    >;
  }
>()("ras-code/cloud/ManagedEndpointRuntime/RasRelayConnectorFactory") {}

interface ActiveConnector {
  readonly handle: RasRelayConnector.RasRelayConnectorHandle;
  readonly configKey: string;
}

function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    connectorToken: config.connectorToken,
    connectorUrl: config.connectorUrl,
    localHttpHost: config.localHttpHost,
    localHttpPort: config.localHttpPort,
  });
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? connector.handle.close.pipe(
        Effect.tap(() => Effect.logInfo("RAS relay connector stopped")),
        Effect.ignore,
      )
    : Effect.void;

export const make = Effect.gen(function* () {
  const connectorFactory = yield* RasRelayConnectorFactory;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const retryGenerationRef = yield* Ref.make(0);
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];
  let retryConnector: (
    configKey: string,
    generation: number,
    attempt: number,
  ) => Effect.Effect<void>;

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    connector.handle.closed.pipe(
      Effect.andThen(
        reconcileSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* Ref.get(activeRef);
            if (active !== connector) return;
            yield* Ref.set(activeRef, null);
            yield* stopConnector(connector);
            const desiredConfig = yield* Ref.get(desiredConfigRef);
            if (!desiredConfig || runtimeConfigKey(desiredConfig) !== connector.configKey) {
              return;
            }
            yield* Effect.logWarning("RAS relay connector disconnected; restarting");
            const generation = yield* Ref.updateAndGet(retryGenerationRef, (value) => value + 1);
            return generation;
          }),
        ),
      ),
      Effect.flatMap((generation) =>
        generation === undefined ? Effect.void : retryConnector(connector.configKey, generation, 0),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("RAS relay connector supervisor failed", { cause }),
      ),
    );

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config) {
      yield* stopActive;
      return { status: "disabled" };
    }
    const nextConfigKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey && (yield* active.handle.isRunning)) {
      return { status: "running", providerKind: "ras_relay" };
    }

    yield* stopActive;
    const started = yield* connectorFactory.start(config).pipe(Effect.result);
    if (Result.isFailure(started)) {
      yield* Effect.logWarning("Failed to start RAS relay connector", {
        stage: started.failure.stage,
        cause: started.failure.cause,
      });
      return {
        status: "failed",
        providerKind: "ras_relay",
        reason: `RAS relay connector failed during ${started.failure.stage}.`,
      };
    }

    const connector = { handle: started.success, configKey: nextConfigKey };
    yield* Ref.set(activeRef, connector);
    yield* Effect.forkDetach(superviseConnector(connector));
    yield* Effect.logInfo("RAS relay connector registered");
    return { status: "running", providerKind: "ras_relay" };
  });

  retryConnector = Effect.fnUntraced(function* (configKey, generation, attempt) {
    const delaySeconds = Math.min(300, 2 ** Math.min(attempt, 8));
    yield* Effect.sleep(Duration.seconds(delaySeconds));
    const outcome = yield* reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(retryGenerationRef)) !== generation) return "stop" as const;
        const desiredConfig = yield* Ref.get(desiredConfigRef);
        if (!desiredConfig || runtimeConfigKey(desiredConfig) !== configKey) return "stop" as const;
        const active = yield* Ref.get(activeRef);
        if (active?.configKey === configKey && (yield* active.handle.isRunning)) {
          return "stop" as const;
        }
        const status = yield* reconcileConfig(desiredConfig);
        return status.status === "failed" ? ("retry" as const) : ("stop" as const);
      }),
    );
    if (outcome === "retry") {
      yield* retryConnector(configKey, generation, attempt + 1);
    }
  });

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig: (config) =>
      reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const generation = yield* Ref.updateAndGet(retryGenerationRef, (value) => value + 1);
          yield* Ref.set(desiredConfigRef, config);
          const status = yield* reconcileConfig(config);
          if (config && status.status === "failed") {
            yield* Effect.forkDetach(retryConnector(runtimeConfigKey(config), generation, 0));
          }
          return status;
        }),
      ),
  });

  const initialConfig = yield* readRuntimeConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  yield* runtime.applyConfig(initialConfig);
  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layerWithConnector = Layer.effect(CloudManagedEndpointRuntime, make);

const connectorLayer = Layer.succeed(
  RasRelayConnectorFactory,
  RasRelayConnectorFactory.of({ start: RasRelayConnector.start }),
);

export const layer = layerWithConnector.pipe(Layer.provide(connectorLayer));
