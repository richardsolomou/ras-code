import { describe, expect, it } from "vite-plus/test";

import { pendingMigrations } from "./migrations.ts";

const file = (id: string) => ({ id, sql: `-- ${id}` });

describe("pendingMigrations", () => {
  it("keeps unapplied migrations in the order they were listed", () => {
    const pending = pendingMigrations(
      [file("0001_baseline"), file("0002_devices"), file("0003_endpoints")],
      new Set<string>(),
    );

    expect(pending.map((migration) => migration.id)).toEqual([
      "0001_baseline",
      "0002_devices",
      "0003_endpoints",
    ]);
  });

  it("skips migrations the database already recorded", () => {
    const pending = pendingMigrations(
      [file("0001_baseline"), file("0002_devices"), file("0003_endpoints")],
      new Set(["0001_baseline", "0002_devices"]),
    );

    expect(pending.map((migration) => migration.id)).toEqual(["0003_endpoints"]);
  });

  it("ignores recorded migrations that are absent from disk", () => {
    const pending = pendingMigrations(
      [file("0001_baseline")],
      new Set(["0009_from_a_newer_branch"]),
    );

    expect(pending.map((migration) => migration.id)).toEqual(["0001_baseline"]);
  });
});
