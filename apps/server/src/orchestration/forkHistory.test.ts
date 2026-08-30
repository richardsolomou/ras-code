import { describe, expect, it } from "vite-plus/test";

import { selectForkInheritedPrefix } from "./forkHistory.ts";

describe("selectForkInheritedPrefix", () => {
  it("includes the selected response and excludes later messages", () => {
    const messages = [
      { id: "later", createdAt: "2026-01-01T00:00:03Z", streaming: false },
      { id: "prompt", createdAt: "2026-01-01T00:00:01Z", streaming: false },
      { id: "response", createdAt: "2026-01-01T00:00:02Z", streaming: false },
    ];

    expect(selectForkInheritedPrefix(messages, "response")?.map((message) => message.id)).toEqual([
      "prompt",
      "response",
    ]);
  });

  it("rejects a missing fork point", () => {
    expect(selectForkInheritedPrefix([], "missing")).toBeNull();
  });

  it("omits streaming messages from inherited history", () => {
    const messages = [
      { id: "streaming", createdAt: "2026-01-01T00:00:01Z", streaming: true },
      { id: "response", createdAt: "2026-01-01T00:00:02Z", streaming: false },
    ];

    expect(selectForkInheritedPrefix(messages, "response")?.map((message) => message.id)).toEqual([
      "response",
    ]);
  });
});
