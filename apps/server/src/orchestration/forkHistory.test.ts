import { describe, expect, it } from "vite-plus/test";

import { resolveForkTurnCount } from "./forkHistory.ts";

describe("resolveForkTurnCount", () => {
  const checkpoints = [{ assistantMessageId: "response", checkpointTurnCount: 3 }];

  it("derives the turn count from the selected response checkpoint", () => {
    expect(
      resolveForkTurnCount(
        [{ id: "response", role: "assistant", streaming: false }],
        checkpoints,
        "response",
        "after",
        99,
      ),
    ).toBe(3);
  });

  it("rejects user messages and streaming responses", () => {
    expect(
      resolveForkTurnCount(
        [{ id: "response", role: "user", streaming: false }],
        checkpoints,
        "response",
        "after",
        3,
      ),
    ).toBeNull();
    expect(
      resolveForkTurnCount(
        [{ id: "response", role: "assistant", streaming: true }],
        checkpoints,
        "response",
        "after",
        3,
      ),
    ).toBeNull();
  });

  it("rejects responses without a checkpoint", () => {
    expect(
      resolveForkTurnCount(
        [{ id: "response", role: "assistant", streaming: false }],
        [],
        "response",
        "after",
        3,
      ),
    ).toBeNull();
  });

  it("preserves the requested count for legacy before-boundary forks", () => {
    expect(resolveForkTurnCount([], [], "prompt", "before", 2)).toBe(2);
  });
});
