import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_ALLOCATION_LIMIT = 20;
const LEGACY_ALLOCATION_TABLE = "relay_managed_endpoint_allocations";
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";

export interface LegacyManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly tunnelId: string | null;
  readonly dnsRecordId: string | null;
  readonly updatedAt: string;
}

export class LegacyManagedEndpointCleanupError extends Schema.TaggedErrorClass<LegacyManagedEndpointCleanupError>()(
  "LegacyManagedEndpointCleanupError",
  {
    stage: Schema.Literals([
      "list-allocations",
      "allocation-limit",
      "claim-allocation",
      "resolve-zone",
      "delete-dns-record",
      "delete-tunnel",
      "remove-allocation",
      "cleanup-incomplete",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Legacy managed endpoint cleanup failed during '${this.stage}'`;
  }
}

export interface LegacyManagedEndpointCleanupOperations {
  readonly claim: (
    allocation: LegacyManagedEndpointAllocation,
  ) => Effect.Effect<string | null, LegacyManagedEndpointCleanupError>;
  readonly deleteDnsRecord: (
    dnsRecordId: string,
  ) => Effect.Effect<void, LegacyManagedEndpointCleanupError>;
  readonly deleteTunnel: (
    tunnelId: string,
  ) => Effect.Effect<void, LegacyManagedEndpointCleanupError>;
  readonly removeClaimed: (
    allocation: LegacyManagedEndpointAllocation,
    claimedAt: string,
  ) => Effect.Effect<boolean, LegacyManagedEndpointCleanupError>;
}

const CloudflareError = Schema.Struct({
  code: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
});
const CloudflareResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(CloudflareError)),
});
const CloudflareZoneResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(CloudflareError)),
  result: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        account: Schema.Struct({ id: Schema.optional(Schema.String) }),
      }),
    ),
  ),
});

function cloudflareErrorMessage(
  errors:
    | ReadonlyArray<{
        readonly code?: number | undefined;
        readonly message?: string | undefined;
      }>
    | undefined,
): string {
  return (
    errors
      ?.map((error) =>
        [error.code, error.message].filter((value) => value !== undefined).join(": "),
      )
      .filter(Boolean)
      .join(", ") || "Cloudflare API request failed"
  );
}

export function cloudflareTunnelDeletePath(accountId: string, tunnelId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}?cascade=true`;
}

function cloudflareRequest(input: {
  readonly token: string;
  readonly path: string;
  readonly method?: "DELETE" | "GET";
  readonly stage: "resolve-zone" | "delete-dns-record" | "delete-tunnel";
}) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `${CLOUDFLARE_API_ORIGIN}${input.path}`;
    const request = (
      input.method === "DELETE" ? HttpClientRequest.delete(url) : HttpClientRequest.get(url)
    ).pipe(HttpClientRequest.bearerToken(input.token), HttpClientRequest.acceptJson);
    return yield* client
      .pipe(
        HttpClient.retryTransient({
          times: 2,
          schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered),
        }),
      )
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) => new LegacyManagedEndpointCleanupError({ stage: input.stage, cause }),
        ),
      );
  });
}

function deleteCloudflareResource(input: {
  readonly token: string;
  readonly path: string;
  readonly stage: "delete-dns-record" | "delete-tunnel";
}) {
  return Effect.gen(function* () {
    const response = yield* cloudflareRequest({
      token: input.token,
      path: input.path,
      method: "DELETE",
      stage: input.stage,
    });
    if (response.status === 404) return;
    const decoded = yield* HttpClientResponse.schemaBodyJson(CloudflareResponse)(response).pipe(
      Effect.mapError(
        (cause) => new LegacyManagedEndpointCleanupError({ stage: input.stage, cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300 || !decoded.success) {
      return yield* new LegacyManagedEndpointCleanupError({
        stage: input.stage,
        cause: cloudflareErrorMessage(decoded.errors),
      });
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (cause) => new LegacyManagedEndpointCleanupError({ stage: input.stage, cause }),
    ),
  );
}

export const cleanupLegacyManagedEndpointRows = Effect.fn(
  "relay.legacy_managed_endpoints.cleanup_rows",
)(function* (
  allocations: ReadonlyArray<LegacyManagedEndpointAllocation>,
  operations: LegacyManagedEndpointCleanupOperations,
) {
  let removed = 0;
  for (const allocation of allocations) {
    const claimedAt = yield* operations.claim(allocation);
    if (claimedAt === null) continue;
    if (allocation.dnsRecordId !== null) {
      yield* operations.deleteDnsRecord(allocation.dnsRecordId);
    }
    if (allocation.tunnelId !== null) {
      yield* operations.deleteTunnel(allocation.tunnelId);
    }
    if (yield* operations.removeClaimed(allocation, claimedAt)) removed += 1;
  }
  return removed;
});

export const cleanupLegacyManagedEndpoints = Effect.fn("relay.legacy_managed_endpoints.cleanup")(
  function* () {
    const databaseUrl = yield* Config.redacted("RELAY_MIGRATION_DATABASE_URL");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const httpClient = yield* HttpClient.HttpClient;
      const table = yield* sql
        .unsafe<{ readonly name: string | null }>(
          `SELECT to_regclass('public.${LEGACY_ALLOCATION_TABLE}')::text AS name`,
        )
        .pipe(
          Effect.mapError(
            (cause) => new LegacyManagedEndpointCleanupError({ stage: "list-allocations", cause }),
          ),
        );
      if (table[0]?.name == null) return 0;

      const listAllocations = () =>
        sql
          .unsafe<LegacyManagedEndpointAllocation>(
            `SELECT user_id AS "userId",
                  environment_id AS "environmentId",
                  tunnel_id AS "tunnelId",
                  dns_record_id AS "dnsRecordId",
                  updated_at AS "updatedAt"
             FROM ${LEGACY_ALLOCATION_TABLE}
            ORDER BY user_id, environment_id
            LIMIT ${LEGACY_ALLOCATION_LIMIT + 1}`,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new LegacyManagedEndpointCleanupError({ stage: "list-allocations", cause }),
            ),
            Effect.filterOrFail(
              (rows) => rows.length <= LEGACY_ALLOCATION_LIMIT,
              () => new LegacyManagedEndpointCleanupError({ stage: "allocation-limit" }),
            ),
          );

      const first = yield* listAllocations();
      if (first.length === 0) return 0;

      const token = Redacted.value(yield* Config.redacted("CLOUDFLARE_API_TOKEN"));
      const accountId = yield* Config.nonEmptyString("CLOUDFLARE_ACCOUNT_ID");
      const zoneName = yield* Config.nonEmptyString("RELAY_GATEWAY_ZONE_NAME");
      const zoneId = yield* first.some((allocation) => allocation.dnsRecordId !== null)
        ? Effect.gen(function* () {
            const query = new URLSearchParams({ name: zoneName, per_page: "5" });
            const response = yield* cloudflareRequest({
              token,
              path: `/zones?${query.toString()}`,
              stage: "resolve-zone",
            });
            const decoded = yield* HttpClientResponse.schemaBodyJson(CloudflareZoneResponse)(
              response,
            ).pipe(
              Effect.mapError(
                (cause) => new LegacyManagedEndpointCleanupError({ stage: "resolve-zone", cause }),
              ),
            );
            const resolvedZoneId =
              decoded.result?.find(
                (zone) => zone.name === zoneName && (zone.account.id ?? accountId) === accountId,
              )?.id ?? null;
            if (
              response.status < 200 ||
              response.status >= 300 ||
              !decoded.success ||
              resolvedZoneId === null
            ) {
              return yield* new LegacyManagedEndpointCleanupError({
                stage: "resolve-zone",
                cause: cloudflareErrorMessage(decoded.errors),
              });
            }
            return resolvedZoneId;
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) => new LegacyManagedEndpointCleanupError({ stage: "resolve-zone", cause }),
            ),
          )
        : Effect.succeed(null);

      const operations: LegacyManagedEndpointCleanupOperations = {
        claim: (allocation) =>
          Effect.gen(function* () {
            const firstRandom = yield* Random.nextInt;
            const secondRandom = yield* Random.nextInt;
            const claimedAt = `relay-cutover:${firstRandom.toString(36)}:${secondRandom.toString(36)}`;
            return yield* sql
              .unsafe<{ readonly userId: string }>(
                `UPDATE ${LEGACY_ALLOCATION_TABLE}
                  SET updated_at = $1
                WHERE user_id = $2 AND environment_id = $3 AND updated_at = $4
            RETURNING user_id AS "userId"`,
                [claimedAt, allocation.userId, allocation.environmentId, allocation.updatedAt],
              )
              .pipe(
                Effect.map((rows) => (rows.length > 0 ? claimedAt : null)),
                Effect.mapError(
                  (cause) =>
                    new LegacyManagedEndpointCleanupError({ stage: "claim-allocation", cause }),
                ),
              );
          }),
        deleteDnsRecord: (dnsRecordId) =>
          zoneId === null
            ? Effect.fail(new LegacyManagedEndpointCleanupError({ stage: "delete-dns-record" }))
            : deleteCloudflareResource({
                token,
                path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(dnsRecordId)}`,
                stage: "delete-dns-record",
              }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        deleteTunnel: (tunnelId) =>
          deleteCloudflareResource({
            token,
            path: cloudflareTunnelDeletePath(accountId, tunnelId),
            stage: "delete-tunnel",
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        removeClaimed: (allocation, claimedAt) =>
          sql
            .unsafe<{ readonly userId: string }>(
              `DELETE FROM ${LEGACY_ALLOCATION_TABLE}
                  WHERE user_id = $1 AND environment_id = $2 AND updated_at = $3
              RETURNING user_id AS "userId"`,
              [allocation.userId, allocation.environmentId, claimedAt],
            )
            .pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.mapError(
                (cause) =>
                  new LegacyManagedEndpointCleanupError({ stage: "remove-allocation", cause }),
              ),
            ),
      };

      let removed = 0;
      let allocations = first;
      for (let attempt = 0; attempt < 3 && allocations.length > 0; attempt += 1) {
        removed += yield* cleanupLegacyManagedEndpointRows(allocations, operations);
        allocations = yield* listAllocations();
      }
      if (allocations.length > 0) {
        return yield* new LegacyManagedEndpointCleanupError({ stage: "cleanup-incomplete" });
      }
      yield* Effect.logInfo("Removed legacy managed endpoint allocations", { count: removed });
      return removed;
    }).pipe(Effect.provide(PgClient.layer({ url: databaseUrl })));
  },
);
