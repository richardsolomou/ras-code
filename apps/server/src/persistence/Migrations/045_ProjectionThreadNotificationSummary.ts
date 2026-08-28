import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Shell-level notification inputs: the newest provider fallback and a one-line
 * preview of the newest settled assistant message. The backfill is a close
 * approximation (SQLite cannot collapse runs of whitespace); the projector
 * rewrites both columns exactly the next time the thread's shell refreshes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "last_fallback_engaged_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_fallback_engaged_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "latest_assistant_summary")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_assistant_summary TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      last_fallback_engaged_at = (
        SELECT MAX(activity.created_at)
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_threads.thread_id
          AND activity.kind = 'provider.fallback.engaged'
      ),
      latest_assistant_summary = (
        SELECT NULLIF(
          substr(
            trim(
              replace(
                replace(replace(message.text, char(13), ' '), char(10), ' '),
                char(9),
                ' '
              )
            ),
            1,
            140
          ),
          ''
        )
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'assistant'
          AND message.is_streaming = 0
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      )
  `;
});
