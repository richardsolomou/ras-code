import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Thread forking: where a fork was cut from, which of its messages are the
 * parent's inherited history, and the provider-opaque anchor a native fork
 * resumes a turn from.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "forked_from_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN forked_from_json TEXT
    `;
  }

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "inherited")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0
    `;
  }

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!turnColumns.some((column) => column.name === "resume_anchor")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN resume_anchor TEXT
    `;
  }
});
