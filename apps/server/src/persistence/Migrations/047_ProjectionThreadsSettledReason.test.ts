import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@ras-code/shared/nodeSqliteClient";
import migration from "./047_ProjectionThreadsSettledReason.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionThreadsSettledReason", (it) => {
  it.effect("backfills pre-existing settles as user settles and leaves the rest null", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, deleted_at, settled_override, settled_at
        )
        VALUES
          ('thread-settled', 'project-1', 'Settled', '{}', 'direct',
            'default', NULL, NULL, NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
            'settled', '2026-01-02T00:00:00.000Z'),
          ('thread-active', 'project-1', 'Pinned active', '{}', 'direct',
            'default', NULL, NULL, NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
            'active', NULL),
          ('thread-plain', 'project-1', 'No override', '{}', 'direct',
            'default', NULL, NULL, NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
            NULL, NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "settled_reason"));

      const rows = yield* sql<{
        readonly threadId: string;
        readonly settledReason: string | null;
      }>`
        SELECT thread_id AS "threadId", settled_reason AS "settledReason"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-active", settledReason: null },
        { threadId: "thread-plain", settledReason: null },
        // A settle that predates the column cannot have been a merge settle,
        // so it must not be disregarded by a client with the toggle off.
        { threadId: "thread-settled", settledReason: "user" },
      ]);
    }),
  );

  // Applied directly rather than through runMigrations, which skips a
  // migration it has already recorded: re-execution is what the column guard
  // and the IS NULL guard exist for.
  it.effect("re-executing neither fails on the existing column nor clobbers a merge settle", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, deleted_at, settled_override, settled_at,
          settled_reason
        )
        VALUES (
          'thread-merged', 'project-1', 'Merge settled', '{}', 'direct',
          'default', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
          'settled', '2026-01-02T00:00:00.000Z', 'merge'
        )
      `;

      yield* migration;

      const rows = yield* sql<{ readonly settledReason: string | null }>`
        SELECT settled_reason AS "settledReason"
        FROM projection_threads
        WHERE thread_id = 'thread-merged'
      `;
      assert.strictEqual(rows[0]?.settledReason, "merge");
    }),
  );
});
