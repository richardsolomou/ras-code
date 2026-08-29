import * as PgClient from "@effect/sql-pg/PgClient";
import { listSqlFiles } from "alchemy/SQL/SqlFile";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tracks applied migration names. The table name is a module constant so it is
 * safe to interpolate into the DDL below, which cannot be parameterized.
 */
const MIGRATIONS_TABLE = "relay_migrations";

interface MigrationRow {
  readonly name: string;
}

interface PendingMigration {
  readonly id: string;
  readonly sql: string;
}

/**
 * Selects the migrations still to run, preserving the order `listSqlFiles`
 * established. Recorded names that no longer exist on disk are ignored rather
 * than treated as drift, so a stage can deploy an older revision.
 */
export function pendingMigrations<A extends PendingMigration>(
  files: ReadonlyArray<A>,
  applied: ReadonlySet<string>,
): ReadonlyArray<A> {
  return files.filter((file) => !applied.has(file.id));
}

/**
 * Applies every generated migration the database has not recorded yet, in
 * filename order, each in its own transaction. Applied names are tracked in
 * `relay_migrations`, so running this on an unchanged migrations directory is a
 * no-op and re-running a failed deploy resumes where it stopped.
 *
 * Returns the names applied by this run.
 */
export const applyRelayMigrations = Effect.fn("relay.migrations.apply")(function* (input: {
  readonly migrationsDir: string;
  readonly url: Redacted.Redacted<string>;
}) {
  const files = yield* listSqlFiles(input.migrationsDir);
  if (files.length === 0) {
    return [] as ReadonlyArray<string>;
  }

  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const recorded = yield* sql.unsafe<MigrationRow>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
    const applied = new Set(recorded.map((row) => row.name));
    const pending = pendingMigrations(files, applied);

    for (const file of pending) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(file.sql);
            yield* sql.unsafe(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [file.id]);
          }),
        )
        .pipe(Effect.withSpan("relay.migrations.applyOne", { attributes: { migration: file.id } }));
    }

    return pending.map((file) => file.id);
  }).pipe(Effect.provide(PgClient.layer({ url: input.url })));
});
