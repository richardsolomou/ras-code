import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "settled_reason")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_reason TEXT
    `;
  }

  // Rows settled before the column existed are all explicit user settles:
  // merge settles could not be recorded yet. Backfilling keeps a client whose
  // auto-settle-on-merge is off from disregarding them as merge settles.
  yield* sql`
    UPDATE projection_threads
    SET settled_reason = 'user'
    WHERE settled_override = 'settled' AND settled_reason IS NULL
  `;
});
