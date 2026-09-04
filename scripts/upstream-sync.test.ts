// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - The test builds an isolated Git repository and fixture ledger through host APIs.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyRebrandedCommit,
  createGitRunner,
  inspectCommitAlignment,
  runAdoptAligned,
} from "./upstream-sync.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const hasMergiraf = NodeChildProcess.spawnSync("mergiraf", ["--version"]).status === 0;

const makeRepository = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ras-upstream-sync-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "RAS Test");
  git(root, "config", "user.email", "ras@example.com");

  const upstreamDir = NodePath.join(root, "oxlint-plugin-t3code");
  NodeFS.mkdirSync(upstreamDir);
  NodeFS.writeFileSync(
    NodePath.join(upstreamDir, "product.ts"),
    'export const forkBehavior = false;\n\nexport const product = "T3 Code";\n',
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "switch", "--quiet", "-c", "upstream");
  NodeFS.writeFileSync(
    NodePath.join(upstreamDir, "product.ts"),
    'export const forkBehavior = false;\n\nexport const product = "T3 Code Next";\nexport const packageName = "t3code";\n',
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: extend product metadata");
  const upstream = git(root, "rev-parse", "HEAD");

  git(root, "switch", "--quiet", "-c", "fork", base);
  git(root, "mv", "oxlint-plugin-t3code", "oxlint-plugin-ras-code");
  NodeFS.writeFileSync(
    NodePath.join(root, "oxlint-plugin-ras-code/product.ts"),
    'export const forkBehavior = true;\n\nexport const product = "RAS Code";\n',
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "chore: rebrand");

  return { base, root, upstream };
};

const makeStructuralMergeRepository = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ras-upstream-structural-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "RAS Test");
  git(root, "config", "user.email", "ras@example.com");
  NodeFS.writeFileSync(
    NodePath.join(root, "config.ts"),
    "export const config = {\n  shared: true,\n};\n",
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "switch", "--quiet", "-c", "upstream");
  NodeFS.writeFileSync(
    NodePath.join(root, "config.ts"),
    "export const config = {\n  upstream: true,\n  shared: true,\n};\n",
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: extend config");
  const upstream = git(root, "rev-parse", "HEAD");

  git(root, "switch", "--quiet", "-c", "fork", base);
  NodeFS.writeFileSync(
    NodePath.join(root, "config.ts"),
    "export const config = {\n  fork: true,\n  shared: true,\n};\n",
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: extend fork config");
  return { root, upstream };
};

describe("aligned upstream adoption", () => {
  it.effect("applies path and text rebranding before committing", () =>
    Effect.gen(function* () {
      const { root, upstream } = yield* Effect.acquireRelease(
        Effect.sync(makeRepository),
        ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const runner = createGitRunner(root);
      const alignment = inspectCommitAlignment(runner, upstream);
      assert.isTrue(alignment.aligned);

      yield* applyRebrandedCommit(runner, upstream, alignment.paths);

      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(root, "oxlint-plugin-ras-code/product.ts"), "utf8"),
        'export const forkBehavior = true;\n\nexport const product = "RAS Code Next";\nexport const packageName = "ras-code";\n',
      );
      assert.match(git(root, "show", "-s", "--format=%B", "HEAD"), /cherry picked from commit/);
    }),
  );

  it("rejects a commit when the fork changed its parent content", () => {
    const { root, upstream } = makeRepository();
    try {
      NodeFS.writeFileSync(
        NodePath.join(root, "oxlint-plugin-ras-code/product.ts"),
        'export const product = "Fork behavior";\n',
      );
      git(root, "add", ".");
      git(root, "commit", "--quiet", "-m", "feat: diverge");

      const alignment = inspectCommitAlignment(createGitRunner(root), upstream);
      assert.isFalse(alignment.aligned);
      assert.deepStrictEqual(alignment.issues, [
        {
          path: "oxlint-plugin-ras-code/product.ts",
          reason: "normalized three-way merge conflicts",
        },
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect.skipIf(!hasMergiraf)("structurally merges an already-judged change", () =>
    Effect.gen(function* () {
      const { root, upstream } = yield* Effect.acquireRelease(
        Effect.sync(makeStructuralMergeRepository),
        ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const runner = createGitRunner(root);
      assert.isFalse(inspectCommitAlignment(runner, upstream).aligned);

      yield* applyRebrandedCommit(runner, upstream, ["config.ts"], {
        allowStructuredMerge: true,
      });

      const contents = NodeFS.readFileSync(NodePath.join(root, "config.ts"), "utf8");
      assert.include(contents, "fork: true");
      assert.include(contents, "upstream: true");
    }),
  );

  it.effect("records and commits an aligned prefix without review", () =>
    Effect.gen(function* () {
      const { base, root, upstream } = yield* Effect.acquireRelease(
        Effect.sync(makeRepository),
        ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      NodeFS.mkdirSync(NodePath.join(root, "upstream"));
      NodeFS.writeFileSync(
        NodePath.join(root, "upstream/sync.json"),
        `${JSON.stringify(
          {
            upstreamRemote: "t3code",
            upstreamBranch: "main",
            forkPoint: base,
            lastReviewed: base,
            entries: [],
          },
          null,
          2,
        )}\n`,
      );
      git(root, "add", "upstream/sync.json");
      git(root, "commit", "--quiet", "-m", "chore: add ledger");
      git(root, "update-ref", "refs/remotes/t3code/main", upstream);

      yield* runAdoptAligned({
        repoRoot: root,
        ledgerPath: NodePath.join(root, "upstream/sync.json"),
        fetch: false,
        dryRun: false,
      }).pipe(Effect.provide(NodeServices.layer));

      const ledger = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, "upstream/sync.json"), "utf8"),
      );
      assert.strictEqual(ledger.lastReviewed, upstream);
      assert.strictEqual(ledger.entries[0]?.decision, "adopted");
      assert.strictEqual(
        git(root, "log", "-1", "--format=%s"),
        `chore(upstream): record aligned changes through ${upstream.slice(0, 9)}`,
      );
    }),
  );
});
