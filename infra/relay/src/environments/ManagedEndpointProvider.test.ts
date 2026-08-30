import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "team",
    keyId: "key",
    privateKey: Redacted.make("private"),
    bundleId: "bundle",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("secret"),
  clerkPublishableKey: "publishable",
  clerkJwtAudience: "audience",
  apnsDeliveryJobSigningSecret: Redacted.make("delivery"),
  cloudMintPrivateKey: Redacted.make("mint-private"),
  cloudMintPublicKey: "mint-public",
  relayGatewayDomain: "code-tunnels.example.test",
  relayEndpointNamespace: "production",
});

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const bytes = new Uint8Array(data.length);
        bytes.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, bytes.buffer));
      }),
  }),
);

const providerLayer = ManagedEndpointProvider.layer.pipe(
  Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
  Layer.provide(cryptoLayer),
);

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a deterministic built-in relay endpoint", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user-1",
        environmentId: "environment-1",
        environmentPublicKey: "public-key-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
      });
      const repeated = yield* provider.provision({
        userId: "user-2",
        environmentId: "environment-1",
        environmentPublicKey: "public-key-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
      });
      const otherKey = yield* provider.provision({
        userId: "user-1",
        environmentId: "environment-1",
        environmentPublicKey: "public-key-2",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
      });

      expect(result.endpoint.providerKind).toBe("ras_relay");
      expect(result.endpoint.httpBaseUrl).toMatch(
        /^https:\/\/code-tunnels\.example\.test\/e\/[a-f0-9]{16}\/$/u,
      );
      expect(result.runtime).toMatchObject({
        providerKind: "ras_relay",
        connectorUrl: expect.stringMatching(
          /^wss:\/\/relay\.example\.test\/v1\/ras-relay\/connect\/[a-f0-9]{16}$/u,
        ),
        localHttpHost: "127.0.0.1",
        localHttpPort: 3000,
      });
      expect(repeated.endpoint).toEqual(result.endpoint);
      expect(otherKey.endpoint).not.toEqual(result.endpoint);
    }).pipe(Effect.provide(providerLayer)),
  );

  it.effect("rejects non-loopback origins", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: "public-key-1",
          origin: { localHttpHost: "192.0.2.1", localHttpPort: 3000 },
        }),
      );
      expect(error._tag).toBe("ManagedEndpointOriginNotAllowed");
    }).pipe(Effect.provide(providerLayer)),
  );
});
