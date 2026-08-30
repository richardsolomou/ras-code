import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  LegacyManagedEndpointCleanupError,
  cleanupLegacyManagedEndpointRows,
  type LegacyManagedEndpointAllocation,
} from "./legacyManagedEndpointCleanup.ts";

const allocation = {
  userId: "user-1",
  environmentId: "environment-1",
  tunnelId: "tunnel-1",
  dnsRecordId: "dns-1",
  updatedAt: "generation-1",
} satisfies LegacyManagedEndpointAllocation;

describe("legacy managed endpoint cleanup", () => {
  it.effect("removes a claimed allocation after its external resources", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const removed = yield* cleanupLegacyManagedEndpointRows([allocation], {
        claim: () => Effect.sync(() => (calls.push("claim"), "claimed-generation")),
        deleteDnsRecord: () => Effect.sync(() => void calls.push("dns")),
        deleteTunnel: () => Effect.sync(() => void calls.push("tunnel")),
        removeClaimed: (_allocation, claimedAt) =>
          Effect.sync(() => {
            calls.push(`remove:${claimedAt}`);
            return true;
          }),
      });

      expect(removed).toBe(1);
      expect(calls).toEqual(["claim", "dns", "tunnel", "remove:claimed-generation"]);
    });
  });

  it.effect("leaves an allocation untouched when another process replaced its generation", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const removed = yield* cleanupLegacyManagedEndpointRows([allocation], {
        claim: () => Effect.succeed(null),
        deleteDnsRecord: () => Effect.sync(() => void calls.push("dns")),
        deleteTunnel: () => Effect.sync(() => void calls.push("tunnel")),
        removeClaimed: () => Effect.sync(() => (calls.push("remove"), true)),
      });

      expect(removed).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  it.effect("keeps a claimed row when deleting an external resource fails", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const error = yield* cleanupLegacyManagedEndpointRows([allocation], {
        claim: () => Effect.succeed("claimed-generation"),
        deleteDnsRecord: () => Effect.sync(() => void calls.push("dns")),
        deleteTunnel: () =>
          Effect.fail(new LegacyManagedEndpointCleanupError({ stage: "delete-tunnel" })),
        removeClaimed: () => Effect.sync(() => (calls.push("remove"), true)),
      }).pipe(Effect.flip);

      expect(error.stage).toBe("delete-tunnel");
      expect(calls).toEqual(["dns"]);
    });
  });
});
