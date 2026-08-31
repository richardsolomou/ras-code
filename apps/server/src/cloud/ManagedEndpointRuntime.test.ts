import type { RelayManagedEndpointRuntimeConfig } from "@ras-code/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as RasRelayConnector from "./RasRelayConnector.ts";

const rasConfig = (token: string): RelayManagedEndpointRuntimeConfig => ({
  providerKind: "ras_relay",
  connectorToken: token,
  connectorUrl: "wss://relay.example/v1/ras-relay/connect/endpoint",
  localHttpHost: "127.0.0.1",
  localHttpPort: 3000,
});

const buildRuntime = (start: ManagedEndpointRuntime.RasRelayConnectorFactory["Service"]["start"]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layerWithConnector.pipe(
        Layer.provide(
          Layer.succeed(
            ManagedEndpointRuntime.RasRelayConnectorFactory,
            ManagedEndpointRuntime.RasRelayConnectorFactory.of({ start }),
          ),
        ),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

const makeHandle = (closed: Deferred.Deferred<void>, onClose: () => void) =>
  ({
    socket: {} as RasRelayConnector.RasRelayConnectorHandle["socket"],
    closed: Deferred.await(closed),
    close: Effect.sync(onClose),
    isRunning: Effect.succeed(true),
  }) satisfies RasRelayConnector.RasRelayConnectorHandle;

describe("CloudManagedEndpointRuntime", () => {
  it.effect("starts, deduplicates, rotates, and stops the built-in relay connector", () =>
    Effect.gen(function* () {
      const starts: Array<string> = [];
      const closes: Array<string> = [];
      const runtime = yield* buildRuntime((config) =>
        Effect.gen(function* () {
          starts.push(config.connectorToken);
          return makeHandle(yield* Deferred.make<void>(), () => closes.push(config.connectorToken));
        }),
      );

      expect(yield* runtime.applyConfig(rasConfig("token-1"))).toEqual({
        status: "running",
        providerKind: "ras_relay",
      });
      yield* runtime.applyConfig(rasConfig("token-1"));
      yield* runtime.applyConfig(rasConfig("token-2"));
      expect(yield* runtime.applyConfig(null)).toEqual({ status: "disabled" });
      expect(starts).toEqual(["token-1", "token-2"]);
      expect(closes).toEqual(["token-1", "token-2"]);
    }),
  );

  it.effect("restarts the desired connector after it disconnects", () =>
    Effect.gen(function* () {
      const firstClosed = yield* Deferred.make<void>();
      const restarted = yield* Deferred.make<void>();
      let starts = 0;
      const runtime = yield* buildRuntime(() =>
        Effect.gen(function* () {
          starts += 1;
          if (starts === 2) yield* Deferred.succeed(restarted, undefined);
          return makeHandle(starts === 1 ? firstClosed : yield* Deferred.make<void>(), () => {});
        }),
      );

      yield* runtime.applyConfig(rasConfig("token"));
      yield* Deferred.succeed(firstClosed, undefined);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(restarted);
      expect(starts).toBe(2);
    }),
  );

  it.effect("reports connector startup failures", () =>
    Effect.gen(function* () {
      const runtime = yield* buildRuntime(() =>
        Effect.fail(
          new RasRelayConnector.RasRelayConnectorStartError({
            stage: "open-connector",
            cause: "offline",
          }),
        ),
      );

      expect(yield* runtime.applyConfig(rasConfig("token"))).toEqual({
        status: "failed",
        providerKind: "ras_relay",
        reason: "RAS relay connector failed during open-connector.",
      });
    }),
  );

  it.effect("retries transient connector startup failures", () =>
    Effect.gen(function* () {
      const restarted = yield* Deferred.make<void>();
      let starts = 0;
      const runtime = yield* buildRuntime(() =>
        Effect.gen(function* () {
          starts += 1;
          if (starts === 1) {
            return yield* new RasRelayConnector.RasRelayConnectorStartError({
              stage: "open-connector",
              cause: "offline",
            });
          }
          yield* Deferred.succeed(restarted, undefined);
          return makeHandle(yield* Deferred.make<void>(), () => {});
        }),
      );

      expect(yield* runtime.applyConfig(rasConfig("token"))).toMatchObject({ status: "failed" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(restarted);
      expect(starts).toBe(2);
    }),
  );

  it.effect("keeps retrying a persistently failing connector at the capped delay", () =>
    Effect.gen(function* () {
      let starts = 0;
      const runtime = yield* buildRuntime(() =>
        Effect.gen(function* () {
          starts += 1;
          return yield* new RasRelayConnector.RasRelayConnectorStartError({
            stage: "open-connector",
            cause: "offline",
          });
        }),
      );

      yield* runtime.applyConfig(rasConfig("token"));
      // Long enough for the doubling to saturate at the cap.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("31 seconds");
      }
      const saturated = starts;
      yield* TestClock.adjust("31 seconds");

      expect(starts).toBe(saturated + 1);
    }),
  );

  it.effect("does not retry a connector after its desired config changes", () =>
    Effect.gen(function* () {
      const starts: Array<string> = [];
      const runtime = yield* buildRuntime((config) =>
        Effect.gen(function* () {
          starts.push(config.connectorToken);
          return yield* new RasRelayConnector.RasRelayConnectorStartError({
            stage: "open-connector",
            cause: "offline",
          });
        }),
      );

      yield* runtime.applyConfig(rasConfig("token-1"));
      yield* runtime.applyConfig(null);
      yield* TestClock.adjust("2 seconds");

      expect(starts).toEqual(["token-1"]);
    }),
  );
});
