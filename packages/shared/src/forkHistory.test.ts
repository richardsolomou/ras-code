import { describe, expect, it } from "vite-plus/test";

import { selectForkInheritedPrefix } from "./forkHistory.js";

describe("selectForkInheritedPrefix", () => {
  it("includes an after-boundary source and excludes later messages", () => {
    const messages = [
      { id: "later", createdAt: "2026-01-01T00:00:03Z", streaming: false },
      { id: "prompt", createdAt: "2026-01-01T00:00:01Z", streaming: false },
      { id: "response", createdAt: "2026-01-01T00:00:02Z", streaming: false },
    ];

    expect(
      selectForkInheritedPrefix(messages, "response", "after")?.map((message) => message.id),
    ).toEqual(["prompt", "response"]);
  });

  it("keeps the legacy source message exclusive when the boundary is omitted", () => {
    const messages = [
      { id: "earlier", createdAt: "2026-01-01T00:00:01Z", streaming: false },
      { id: "source", createdAt: "2026-01-01T00:00:02Z", streaming: false },
    ];

    expect(selectForkInheritedPrefix(messages, "source")?.map((message) => message.id)).toEqual([
      "earlier",
    ]);
  });

  it("returns null when the source message is missing", () => {
    expect(selectForkInheritedPrefix([], "missing")).toBeNull();
  });

  it("omits streaming messages from the inherited prefix", () => {
    const messages = [
      { id: "prompt", createdAt: "2026-01-01T00:00:01Z", streaming: true },
      { id: "response", createdAt: "2026-01-01T00:00:02Z", streaming: false },
    ];

    expect(
      selectForkInheritedPrefix(messages, "response", "after")?.map((message) => message.id),
    ).toEqual(["response"]);
  });
});
