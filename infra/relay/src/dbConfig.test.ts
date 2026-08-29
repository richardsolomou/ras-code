import { describe, expect, it } from "vite-plus/test";

import { relayDatabaseName } from "./dbConfig.ts";

describe("relayDatabaseName", () => {
  it("uses the unsuffixed base name for production", () => {
    expect(relayDatabaseName("prod", "ras-code-relay")).toBe("ras-code-relay");
  });

  it("gives every other stage its own database", () => {
    expect(relayDatabaseName("dev_julius", "ras-code-relay")).toBe("ras-code-relay-dev-julius");
  });

  it("sanitizes stage names into a valid database suffix", () => {
    expect(relayDatabaseName("Preview/PR 42", "ras-code-relay")).toBe(
      "ras-code-relay-preview-pr-42",
    );
  });
});
