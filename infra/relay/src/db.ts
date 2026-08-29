import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayDatabaseName } from "./dbConfig.ts";
import { applyRelayMigrations } from "./migrations.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("ras-code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("ras-code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

const DEFAULT_DATABASE_NAME = "ras-code-relay";

/**
 * Connection details for the self-hosted Postgres behind the managed tunnel.
 *
 * The database is published through a Cloudflare Tunnel and guarded by an
 * Access application, so Hyperdrive authenticates with a service token rather
 * than reaching a public port. Every stage points at the same server; each
 * non-production stage gets its own database on it.
 */
export const RelayDatabaseOrigin = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const host = yield* Config.nonEmptyString("RELAY_DATABASE_HOST");
  const baseName = yield* Config.nonEmptyString("RELAY_DATABASE_NAME").pipe(
    Config.withDefault(DEFAULT_DATABASE_NAME),
  );
  const user = yield* Config.nonEmptyString("RELAY_DATABASE_USER");
  const password = yield* Config.redacted("RELAY_DATABASE_PASSWORD");
  const accessClientId = yield* Config.redacted("RELAY_DATABASE_ACCESS_CLIENT_ID");
  const accessClientSecret = yield* Config.redacted("RELAY_DATABASE_ACCESS_CLIENT_SECRET");

  return {
    scheme: "postgres",
    host,
    database: relayDatabaseName(stage, baseName),
    user,
    password,
    accessClientId,
    accessClientSecret,
  } as const;
});

/**
 * Generates migrations from the Drizzle schema and applies the ones this
 * database has not seen.
 *
 * Migrations run from the deploy host rather than the Worker, so they use a
 * direct connection string instead of Hyperdrive. In CI that string points at a
 * loopback port held open by `cloudflared access tcp` for the length of the
 * deploy; locally it points wherever the developer's tunnel is bound.
 */
export const RelayDatabase = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });
  const origin = yield* RelayDatabaseOrigin;
  const migrationUrl = yield* Config.redacted("RELAY_MIGRATION_DATABASE_URL");

  const applied = yield* applyRelayMigrations({
    migrationsDir: yield* yield* schema.out,
    url: migrationUrl,
  }).pipe(Effect.orDie);

  return { origin, applied };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const origin = yield* RelayDatabaseOrigin;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});
