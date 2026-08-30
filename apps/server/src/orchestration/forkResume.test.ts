import { describe, expect, it } from "@effect/vitest";

import { resolveForkResumeCursor, type ForkResumeInput } from "./forkResume.ts";

const ANCHOR = "11111111-2222-3333-4444-555555555555";

const base: ForkResumeInput = {
  forkedFrom: { turnCount: 2 },
  parentResumeCursor: { threadId: "thread-parent", resume: "session-parent", turnCount: 2 },
  parentContinuationKey: "claudeAgent:home:/home/dev/.claude",
  desiredContinuationKey: "claudeAgent:home:/home/dev/.claude",
  parentTurns: [
    { checkpointTurnCount: 1, resumeAnchor: "older-anchor" },
    { checkpointTurnCount: 2, resumeAnchor: ANCHOR },
    { checkpointTurnCount: 3, resumeAnchor: "newer-anchor" },
  ],
};

describe("resolveForkResumeCursor", () => {
  it("branches at the anchor of the turn the fork was cut after", () => {
    expect(resolveForkResumeCursor(base)).toEqual({
      threadId: "thread-parent",
      resume: "session-parent",
      turnCount: 2,
      forkAtAnchor: ANCHOR,
    });
  });

  it("answers nothing for a thread that is not a fork", () => {
    expect(resolveForkResumeCursor({ ...base, forkedFrom: null })).toBeUndefined();
  });

  it("answers nothing when the fork precedes the parent's first turn", () => {
    expect(resolveForkResumeCursor({ ...base, forkedFrom: { turnCount: 0 } })).toBeUndefined();
  });

  it("answers nothing when the parent never recorded a resume cursor", () => {
    expect(resolveForkResumeCursor({ ...base, parentResumeCursor: null })).toBeUndefined();
  });

  it("answers nothing when the target provider cannot read the parent's session", () => {
    expect(
      resolveForkResumeCursor({ ...base, desiredContinuationKey: "codex:home:/home/dev/.codex" }),
    ).toBeUndefined();
    expect(resolveForkResumeCursor({ ...base, parentContinuationKey: undefined })).toBeUndefined();
  });

  it("answers nothing when the parent turn recorded no anchor", () => {
    // Every provider without a fork primitive lands here.
    expect(
      resolveForkResumeCursor({
        ...base,
        parentTurns: [{ checkpointTurnCount: 2, resumeAnchor: null }],
      }),
    ).toBeUndefined();
    expect(
      resolveForkResumeCursor({
        ...base,
        parentTurns: [{ checkpointTurnCount: 2, resumeAnchor: "" }],
      }),
    ).toBeUndefined();
  });

  it("answers nothing when the fork point's turn is missing from the projection", () => {
    expect(
      resolveForkResumeCursor({
        ...base,
        parentTurns: [{ checkpointTurnCount: 5, resumeAnchor: ANCHOR }],
      }),
    ).toBeUndefined();
  });

  it("passes the parent's cursor through untouched apart from the anchor", () => {
    const cursor = resolveForkResumeCursor({
      ...base,
      parentResumeCursor: { opaque: { nested: true }, resume: "session-parent" },
    });
    expect(cursor).toEqual({
      opaque: { nested: true },
      resume: "session-parent",
      forkAtAnchor: ANCHOR,
    });
  });
});
