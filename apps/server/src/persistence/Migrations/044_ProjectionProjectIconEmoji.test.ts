import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionProjectIconEmoji", (it) => {
  it.effect("adds the nullable icon emoji to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const iconEmoji = columns.find((column) => column.name === "icon_emoji");

      assert.equal(iconEmoji?.name, "icon_emoji");
      assert.equal(iconEmoji?.notnull, 0);
    }),
  );
});
