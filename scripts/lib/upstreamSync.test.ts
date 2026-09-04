import { assert, describe, it } from "@effect/vitest";

import {
  advanceLastReviewed,
  classifyArea,
  classifyPathPolicy,
  decodeUpstreamSyncLedger,
  encodeUpstreamSyncLedger,
  groupCommitsByPullRequest,
  parsePullRequestNumber,
  recordDecision,
  suggestAction,
  summarizeAreas,
  type UpstreamSyncEntry,
  type UpstreamSyncLedger,
} from "./upstreamSync.ts";

const ledgerJson = JSON.stringify({
  upstreamRemote: "upstream",
  upstreamBranch: "main",
  forkPoint: "e2d4d12a81516b55abbecdc64794971f781cacd8",
  lastReviewed: "e2d4d12a81516b55abbecdc64794971f781cacd8",
  entries: [],
});

const entry = (overrides: Partial<UpstreamSyncEntry>): UpstreamSyncEntry => ({
  upstream: "aaa",
  pr: 1,
  title: "title",
  decision: "adopted",
  ours: null,
  reason: "reason",
  reviewedAt: "2026-08-28T00:00:00.000Z",
  ...overrides,
});

describe("ledger schema", () => {
  it("decodes the seeded ledger", () => {
    assert.strictEqual(decodeUpstreamSyncLedger(ledgerJson).upstreamRemote, "upstream");
  });

  it("rejects an unknown decision", () => {
    const invalid = JSON.stringify({
      ...JSON.parse(ledgerJson),
      entries: [{ ...entry({}), decision: "maybe" }],
    });
    assert.throws(() => decodeUpstreamSyncLedger(invalid));
  });

  it("rejects a missing lastReviewed", () => {
    const { lastReviewed: _omitted, ...rest } = JSON.parse(ledgerJson);
    assert.throws(() => decodeUpstreamSyncLedger(JSON.stringify(rest)));
  });

  it("round-trips through encode as newline-terminated pretty JSON", () => {
    const encoded = encodeUpstreamSyncLedger(decodeUpstreamSyncLedger(ledgerJson));
    assert.ok(encoded.endsWith("\n"));
    assert.deepStrictEqual(decodeUpstreamSyncLedger(encoded), decodeUpstreamSyncLedger(ledgerJson));
  });
});

describe("parsePullRequestNumber", () => {
  it("reads the trailing squash marker", () => {
    assert.strictEqual(parsePullRequestNumber("feat(web): pin threads (#8235)"), 8235);
  });

  it("returns null when a commit landed without a pull request", () => {
    assert.strictEqual(parsePullRequestNumber("fix(release): move nightly schedule"), null);
  });

  it("ignores an issue reference that is not the subject suffix", () => {
    assert.strictEqual(parsePullRequestNumber("fix: closes (#12) for real"), null);
  });
});

describe("groupCommitsByPullRequest", () => {
  it("collapses commits that share a pull request", () => {
    const changes = groupCommitsByPullRequest([
      { sha: "a1", subject: "feat: one (#10)" },
      { sha: "a2", subject: "fix: two (#10)" },
    ]);
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(
      changes[0]!.commits.map((commit) => commit.sha),
      ["a1", "a2"],
    );
  });

  it("keeps commits without a pull request separate", () => {
    const changes = groupCommitsByPullRequest([
      { sha: "a1", subject: "chore: one" },
      { sha: "a2", subject: "chore: two" },
    ]);
    assert.deepStrictEqual(
      changes.map((change) => change.key),
      ["a1", "a2"],
    );
  });

  it("strips the squash marker from the change title", () => {
    const [change] = groupCommitsByPullRequest([{ sha: "a1", subject: "feat: pin threads (#10)" }]);
    assert.strictEqual(change!.title, "feat: pin threads");
  });

  it("preserves upstream history order", () => {
    const changes = groupCommitsByPullRequest([
      { sha: "a1", subject: "feat: one (#10)" },
      { sha: "a2", subject: "chore: loose" },
      { sha: "a3", subject: "fix: one again (#10)" },
    ]);
    assert.deepStrictEqual(
      changes.map((change) => change.key),
      ["pr-10", "a2"],
    );
  });
});

describe("classifyArea", () => {
  it("buckets client-runtime with the shared packages", () => {
    assert.strictEqual(
      classifyArea("packages/client-runtime/src/connection/resolver.ts"),
      "shared",
    );
  });

  it("buckets workflows as ci", () => {
    assert.strictEqual(classifyArea(".github/workflows/ci.yml"), "ci");
  });

  it("buckets everything else as other", () => {
    assert.strictEqual(classifyArea("pnpm-lock.yaml"), "other");
  });

  it("lists hit areas in a stable order", () => {
    assert.deepStrictEqual(summarizeAreas(["docs/x.md", "apps/server/src/y.ts"]), [
      "server",
      "docs",
    ]);
  });
});

describe("classifyPathPolicy", () => {
  it("marks wire contracts", () => {
    assert.strictEqual(classifyPathPolicy("packages/contracts/src/ws.ts").kind, "wire");
  });

  it("marks the marketing site as replaced", () => {
    assert.strictEqual(classifyPathPolicy("apps/marketing/src/index.astro").kind, "replaced");
  });

  it("marks brand assets as replaced", () => {
    assert.strictEqual(classifyPathPolicy("apps/desktop/icon.png").kind, "replaced");
  });

  it("marks legal pages as replaced", () => {
    assert.strictEqual(classifyPathPolicy("apps/web/src/legal/terms.tsx").kind, "replaced");
  });

  it("marks deleted mobile surfaces as removed", () => {
    assert.strictEqual(
      classifyPathPolicy("apps/mobile/src/features/threads/thread-list-items.tsx").kind,
      "removed",
    );
    assert.strictEqual(
      classifyPathPolicy("apps/mobile/generated-uniwind-themes.css").kind,
      "removed",
    );
  });

  it("leaves ordinary source alone", () => {
    assert.strictEqual(classifyPathPolicy("apps/server/src/ws.ts").kind, "normal");
  });
});

describe("suggestAction", () => {
  it("adopts a change in ordinary source", () => {
    assert.strictEqual(suggestAction(["apps/server/src/x.ts"]).action, "adopt");
  });

  it("skips a change confined to surfaces we replaced", () => {
    assert.strictEqual(suggestAction(["apps/marketing/src/index.astro"]).action, "skip");
  });

  it("adapts a change that only partly touches replaced surfaces", () => {
    assert.strictEqual(
      suggestAction(["apps/marketing/src/index.astro", "apps/server/src/x.ts"]).action,
      "adapt",
    );
  });

  it("warns about wire contracts", () => {
    assert.match(suggestAction(["packages/contracts/src/ws.ts"]).reason, /wire protocol/);
  });
});

describe("advanceLastReviewed", () => {
  const base: UpstreamSyncLedger = {
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    forkPoint: "fork",
    lastReviewed: "fork",
    entries: [],
  };

  it("stops at the first undecided commit", () => {
    const ledger = { ...base, entries: [entry({ upstream: "c1" }), entry({ upstream: "c3" })] };
    assert.strictEqual(advanceLastReviewed(ledger, ["c1", "c2", "c3"]), "c1");
  });

  it("advances across a fully decided prefix", () => {
    const ledger = {
      ...base,
      entries: [entry({ upstream: "c1" }), entry({ upstream: "c2" }), entry({ upstream: "c3" })],
    };
    assert.strictEqual(advanceLastReviewed(ledger, ["c1", "c2", "c3"]), "c3");
  });

  it("holds still when nothing is decided", () => {
    assert.strictEqual(advanceLastReviewed(base, ["c1"]), "fork");
  });
});

describe("recordDecision", () => {
  const base: UpstreamSyncLedger = {
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    forkPoint: "fork",
    lastReviewed: "fork",
    entries: [],
  };

  it("keeps entries in upstream history order", () => {
    const withThird = recordDecision(base, entry({ upstream: "c3" }), ["c1", "c2", "c3"]);
    const withFirst = recordDecision(withThird, entry({ upstream: "c1" }), ["c1", "c2", "c3"]);
    assert.deepStrictEqual(
      withFirst.entries.map((existing) => existing.upstream),
      ["c1", "c3"],
    );
  });

  it("does not advance lastReviewed past an undecided commit", () => {
    const recorded = recordDecision(base, entry({ upstream: "c3" }), ["c1", "c2", "c3"]);
    assert.strictEqual(recorded.lastReviewed, "fork");
  });

  it("replaces an earlier decision for the same commit", () => {
    const first = recordDecision(base, entry({ upstream: "c1", decision: "deferred" }), ["c1"]);
    const second = recordDecision(first, entry({ upstream: "c1", decision: "adopted" }), ["c1"]);
    assert.strictEqual(second.entries.length, 1);
    assert.strictEqual(second.entries[0]!.decision, "adopted");
  });

  it("advances lastReviewed once the prefix is complete", () => {
    const first = recordDecision(base, entry({ upstream: "c1" }), ["c1", "c2"]);
    const second = recordDecision(first, entry({ upstream: "c2" }), ["c1", "c2"]);
    assert.strictEqual(second.lastReviewed, "c2");
  });
});
