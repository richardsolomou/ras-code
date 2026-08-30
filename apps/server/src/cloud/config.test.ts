import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  readAgentActivityPublishingActive,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
  decodeRuntimeConfig,
  isStaleManagedEndpointRuntimeConfig,
} from "./config.ts";

describe("managed relay runtime config", () => {
  it("rejects stale cloudflared runtime state", () => {
    const decoded = decodeRuntimeConfig(
      JSON.stringify({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-id",
      }),
    );

    expect(Option.isNone(decoded)).toBe(true);
    expect(
      isStaleManagedEndpointRuntimeConfig(
        JSON.stringify({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
          tunnelId: "tunnel-id",
        }),
      ),
    ).toBe(true);
  });

  it("does not classify publish-only or RAS relay state as stale", () => {
    expect(isStaleManagedEndpointRuntimeConfig(null)).toBe(false);
    expect(
      isStaleManagedEndpointRuntimeConfig(
        JSON.stringify({
          providerKind: "ras_relay",
          connectorToken: "token",
          connectorUrl: "wss://code-relay.ras.sh/v1/ras-relay/connect/abcdef0123456789",
          localHttpHost: "127.0.0.1",
          localHttpPort: 7331,
        }),
      ),
    ).toBe(false);
  });

  it.effect("disables publishing when legacy managed runtime state remains", () =>
    Effect.gen(function* () {
      const values = new Map([
        [PUBLISH_AGENT_ACTIVITY_SECRET, "true"],
        [RELAY_URL_SECRET, "https://code-relay.ras.sh"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "credential"],
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, '{"providerKind":"cloudflare_tunnel"}'],
      ]);
      const secrets = {
        get: (name: string) =>
          Effect.succeed(
            values.has(name)
              ? Option.some(new TextEncoder().encode(values.get(name)!))
              : Option.none(),
          ),
        set: () => Effect.die("unused set"),
        create: () => Effect.die("unused create"),
        getOrCreateRandom: () => Effect.die("unused getOrCreateRandom"),
        remove: () => Effect.die("unused remove"),
      } satisfies ServerSecretStore.ServerSecretStore["Service"];

      expect(yield* readAgentActivityPublishingActive(secrets)).toBe(false);
    }),
  );
});
