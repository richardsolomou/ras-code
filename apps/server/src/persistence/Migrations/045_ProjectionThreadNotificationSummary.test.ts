import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionThreadNotificationSummary", (it) => {
  it.effect("adds the notification summary columns and backfills them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'thread-1', 'project-1', 'Fix the sidebar', '{}', 'direct',
          'default', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        VALUES
          ('activity-1', 'thread-1', NULL, 'info', 'provider.fallback.engaged', '', '{}',
            '2026-01-01T00:01:00.000Z'),
          ('activity-2', 'thread-1', NULL, 'info', 'tool.completed', '', '{}',
            '2026-01-01T00:02:00.000Z'),
          ('activity-3', 'thread-1', NULL, 'info', 'provider.fallback.engaged', '', '{}',
            '2026-01-01T00:03:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES
          ('message-1', 'thread-1', NULL, 'assistant', 'older reply', 0,
            '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z'),
          ('message-2', 'thread-1', NULL, 'assistant', '  Done\nwith it  ', 0,
            '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:00.000Z'),
          ('message-3', 'thread-1', NULL, 'assistant', 'still typing', 1,
            '2026-01-01T00:03:00.000Z', '2026-01-01T00:03:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "last_fallback_engaged_at"));
      assert.ok(columns.some((column) => column.name === "latest_assistant_summary"));

      const rows = yield* sql<{
        readonly lastFallbackEngagedAt: string | null;
        readonly latestAssistantSummary: string | null;
      }>`
        SELECT
          last_fallback_engaged_at AS "lastFallbackEngagedAt",
          latest_assistant_summary AS "latestAssistantSummary"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.lastFallbackEngagedAt, "2026-01-01T00:03:00.000Z");
      assert.strictEqual(rows[0]?.latestAssistantSummary, "Done with it");
    }),
  );
});
