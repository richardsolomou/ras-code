#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off - Host-side maintenance script: it shells out to git and stamps the ledger with wall-clock time.

/**
 * Reports what changed upstream since we last reviewed, and records what we decided.
 *
 * `report` groups the unreviewed first-parent commits into pull requests and, for each, lists the
 * files with our path mapping applied, the areas hit, and the paths that land on surfaces we keep
 * or replaced. It says nothing about how a patch would apply; the agent reads the real diff.
 *
 * `mark` writes one decision into `upstream/sync.json` and advances `lastReviewed` only across the
 * leading run of commits that now have entries.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  collectUnmappedBrandTokensFromDiff,
  mapUpstreamPath,
  rebrandPatch,
  rebrandText,
  type UnmappedBrandToken,
} from "./lib/upstreamRebrandMap.ts";
import {
  collectDeclaredDependencies,
  findImportResidue,
  findPathResidue,
  findUndeclaredForkDependencies,
  formatResidue,
  formatUndeclaredForkDependencies,
} from "./lib/upstreamVerify.ts";
import {
  UPSTREAM_SYNC_LEDGER_PATH,
  UpstreamSyncDecision,
  classifyPathPolicy,
  decodeUpstreamSyncLedger,
  encodeUpstreamSyncLedger,
  groupCommitsByPullRequest,
  recordDecision,
  suggestAction,
  summarizeAreas,
  type UpstreamChange,
  type UpstreamCommit,
  type UpstreamSyncLedger,
} from "./lib/upstreamSync.ts";

export class UpstreamSyncGitError extends Schema.TaggedErrorClass<UpstreamSyncGitError>()(
  "UpstreamSyncGitError",
  {
    args: Schema.Array(Schema.String),
    status: Schema.Number,
    stderr: Schema.String,
  },
) {}

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  readonly run: (args: ReadonlyArray<string>, input?: string) => GitResult;
  readonly repoRoot: string;
}

export function createGitRunner(repoRoot: string): GitRunner {
  return {
    repoRoot,
    run: (args, input) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        maxBuffer: 256 * 1024 * 1024,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

const gitOrFail = (git: GitRunner, args: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const result = git.run(args);
    return result.status === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new UpstreamSyncGitError({ args, status: result.status, stderr: result.stderr }),
        );
  });

const gitWithInputOrFail = (git: GitRunner, args: ReadonlyArray<string>, input: string) =>
  Effect.suspend(() => {
    const result = git.run(args, input);
    return result.status === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new UpstreamSyncGitError({ args, status: result.status, stderr: result.stderr }),
        );
  });

/** Reads the unreviewed first-parent commits, oldest first. */
export const listUpstreamCommits = Effect.fn("listUpstreamCommits")(function* (
  git: GitRunner,
  range: string,
) {
  const output = yield* gitOrFail(git, [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x00%s",
    range,
  ]);
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): UpstreamCommit => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    });
});

export interface ChangedFile {
  readonly upstreamPath: string;
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

/** Files a commit touched, with our path mapping applied. Renames are read as delete plus add. */
export const listCommitFiles = Effect.fn("listCommitFiles")(function* (
  git: GitRunner,
  sha: string,
) {
  const output = yield* gitOrFail(git, ["diff", "--no-renames", "--numstat", `${sha}^`, sha]);
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): ChangedFile => {
      const [insertions = "0", deletions = "0", upstreamPath = ""] = line.split("\t");
      return {
        upstreamPath,
        path: mapUpstreamPath(upstreamPath),
        insertions: Number.parseInt(insertions, 10) || 0,
        deletions: Number.parseInt(deletions, 10) || 0,
      };
    });
});

export interface ChangeReport {
  readonly change: UpstreamChange;
  readonly files: ReadonlyArray<ChangedFile>;
  readonly insertions: number;
  readonly deletions: number;
  /** Mapped paths we have already touched since the fork point. */
  readonly overlapping: ReadonlyArray<string>;
}

const upstreamRepositoryUrl = "https://github.com/pingdotgg/t3code";

export const buildChangeReport = Effect.fn("buildChangeReport")(function* (
  git: GitRunner,
  change: UpstreamChange,
  ourChangedPaths: ReadonlySet<string>,
) {
  const files: Array<ChangedFile> = [];
  for (const commit of change.commits) {
    files.push(...(yield* listCommitFiles(git, commit.sha)));
  }

  return {
    change,
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    overlapping: [...new Set(files.map((file) => file.path))]
      .filter((path) => ourChangedPaths.has(path))
      .sort(),
  } satisfies ChangeReport;
});

const changeHeading = (report: ChangeReport) =>
  report.change.pr === null
    ? `\`${report.change.commits[0]!.sha.slice(0, 9)}\` — ${report.change.title}`
    : `#${report.change.pr} — ${report.change.title}`;

const changeLink = (pr: number | null, sha: string) =>
  pr === null ? `\`${sha.slice(0, 9)}\`` : `[#${pr}](${upstreamRepositoryUrl}/pull/${pr})`;

/** Reads the range's added lines and asks the rebrand table which brand tokens it cannot decide. */
export function collectUnmappedBrandTokens(
  git: GitRunner,
  range: string,
): ReadonlyArray<UnmappedBrandToken> {
  const diff = git.run(["diff", "--no-renames", range]);
  return diff.status === 0 ? collectUnmappedBrandTokensFromDiff(diff.stdout) : [];
}

export function renderReport(input: {
  readonly ledger: UpstreamSyncLedger;
  readonly upstreamHead: string;
  readonly reports: ReadonlyArray<ChangeReport>;
  readonly unmappedTokens?: ReadonlyArray<UnmappedBrandToken>;
  readonly generatedAt: string;
}): string {
  const { ledger, reports, upstreamHead } = input;
  const lines: Array<string> = [];
  const commitCount = reports.reduce((total, report) => total + report.change.commits.length, 0);

  lines.push(`# Upstream changes since ${ledger.lastReviewed.slice(0, 9)}`);
  lines.push("");
  lines.push(
    `\`${ledger.upstreamRemote}/${ledger.upstreamBranch}\` at \`${upstreamHead.slice(0, 9)}\` · ` +
      `fork point \`${ledger.forkPoint.slice(0, 9)}\` · generated ${input.generatedAt}`,
  );
  lines.push("");

  if (reports.length === 0) {
    lines.push("Nothing new upstream. The ledger is current.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`${commitCount} unreviewed commits in ${reports.length} changes.`);
  lines.push("");

  const unmapped = input.unmappedTokens ?? [];
  if (unmapped.length > 0) {
    lines.push("## Brand tokens the rebrand map cannot decide");
    lines.push("");
    lines.push(
      "Extend `scripts/lib/upstreamRebrandMap.ts` before picking, or each of these interrupts a pick.",
    );
    lines.push("");
    lines.push("| Token | Added lines |");
    lines.push("| --- | --- |");
    for (const { token, count } of unmapped) {
      lines.push(`| \`${token}\` | ${count} |`);
    }
    lines.push("");
  }
  lines.push("| Change | Title | Areas | Files | +/- | Suggested |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const report of reports) {
    const paths = report.files.map((file) => file.path);
    const areas = summarizeAreas(paths).join(", ") || "—";
    lines.push(
      `| ${changeLink(report.change.pr, report.change.commits[0]!.sha)} | ${report.change.title} | ` +
        `${areas} | ${report.files.length} | +${report.insertions}/-${report.deletions} | ` +
        `${suggestAction(paths).action} |`,
    );
  }
  lines.push("");

  for (const report of reports) {
    const suggestion = suggestAction(report.files.map((file) => file.path));
    lines.push(`## ${changeHeading(report)}`);
    lines.push("");
    lines.push(
      `Commits: ${report.change.commits.map((commit) => `\`${commit.sha.slice(0, 9)}\``).join(", ")}`,
    );
    lines.push("");
    lines.push(`Suggested action: **${suggestion.action}** — ${suggestion.reason}`);
    lines.push("");
    lines.push("| Upstream path | Our path | +/- | Note |");
    lines.push("| --- | --- | --- | --- |");
    for (const file of report.files) {
      const policy = classifyPathPolicy(file.path);
      lines.push(
        `| \`${file.upstreamPath}\` | ${file.upstreamPath === file.path ? "same" : `\`${file.path}\``} | ` +
          `+${file.insertions}/-${file.deletions} | ${policy.reason ?? ""} |`,
      );
    }
    lines.push("");
    if (report.overlapping.length > 0) {
      lines.push("Files we already changed since the fork point:");
      lines.push("");
      for (const path of report.overlapping) {
        lines.push(`- \`${path}\``);
      }
      lines.push("");
    }
    lines.push("Read the diff:");
    lines.push("");
    lines.push("```bash");
    for (const commit of report.change.commits) {
      lines.push(`git show ${commit.sha}`);
    }
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

const readLedger = Effect.fn("readLedger")(function* (ledgerPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return decodeUpstreamSyncLedger(yield* fs.readFileString(ledgerPath));
});

const upstreamRange = (ledger: UpstreamSyncLedger) =>
  `${ledger.lastReviewed}..${ledger.upstreamRemote}/${ledger.upstreamBranch}`;

export const runReport = Effect.fn("runReport")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
  readonly out: string | undefined;
  readonly fetch: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const git = createGitRunner(options.repoRoot);
  const ledger = yield* readLedger(options.ledgerPath);

  if (options.fetch) {
    yield* gitOrFail(git, ["fetch", ledger.upstreamRemote, ledger.upstreamBranch]);
  }

  const upstreamHead = (yield* gitOrFail(git, [
    "rev-parse",
    `${ledger.upstreamRemote}/${ledger.upstreamBranch}`,
  ])).trim();
  const changes = groupCommitsByPullRequest(yield* listUpstreamCommits(git, upstreamRange(ledger)));
  const ourChangedPaths = new Set(
    (yield* gitOrFail(git, ["diff", "--name-only", `${ledger.forkPoint}..HEAD`]))
      .split("\n")
      .filter((line) => line.length > 0),
  );

  const reports: Array<ChangeReport> = [];
  for (const change of changes) {
    reports.push(yield* buildChangeReport(git, change, ourChangedPaths));
  }

  const markdown = renderReport({
    ledger,
    upstreamHead,
    reports,
    unmappedTokens: collectUnmappedBrandTokens(git, upstreamRange(ledger)),
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  if (options.out === undefined) {
    yield* Console.log(markdown);
  } else {
    yield* fs.writeFileString(options.out, markdown);
    yield* Console.log(`Wrote ${options.out}`);
  }
});

export const runMark = Effect.fn("runMark")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
  readonly upstream: string;
  readonly decision: UpstreamSyncDecision;
  readonly ours: string | undefined;
  readonly intent: string | undefined;
  readonly reason: string;
  readonly fetch: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const git = createGitRunner(options.repoRoot);
  const ledger = yield* readLedger(options.ledgerPath);

  if (options.fetch) {
    yield* gitOrFail(git, ["fetch", ledger.upstreamRemote, ledger.upstreamBranch]);
  }

  const sha = (yield* gitOrFail(git, ["rev-parse", options.upstream])).trim();
  const subject = (yield* gitOrFail(git, ["log", "-1", "--format=%s", sha])).trim();
  const pending = (yield* listUpstreamCommits(git, upstreamRange(ledger))).map(
    (commit) => commit.sha,
  );
  const ours =
    options.ours === undefined ? null : (yield* gitOrFail(git, ["rev-parse", options.ours])).trim();

  const change = groupCommitsByPullRequest([{ sha, subject }])[0]!;
  const next = recordDecision(
    ledger,
    {
      upstream: sha,
      pr: change.pr,
      title: change.title,
      decision: options.decision,
      ...(options.intent === undefined ? {} : { intent: options.intent }),
      ours,
      reason: options.reason,
      reviewedAt: new Date().toISOString(),
    },
    pending,
  );

  yield* fs.writeFileString(options.ledgerPath, encodeUpstreamSyncLedger(next));
  yield* Console.log(
    `Recorded ${options.decision} for ${sha.slice(0, 9)}; lastReviewed is now ${next.lastReviewed.slice(0, 9)}.`,
  );
  if (pending.includes(sha) && next.lastReviewed !== sha) {
    yield* Console.log("lastReviewed is held back by an earlier undecided commit.");
  }
});

const ledgerFlag = Flag.string("ledger").pipe(
  Flag.withDescription("Path to the sync ledger."),
  Flag.withDefault(UPSTREAM_SYNC_LEDGER_PATH),
);

const repoFlag = Flag.string("repo").pipe(
  Flag.withDescription("Repository root the git commands run in."),
  Flag.withDefault("."),
);

const noFetchFlag = Flag.boolean("no-fetch").pipe(
  Flag.withDescription("Skip fetching the upstream remote first."),
  Flag.withDefault(false),
);

const reportCommand = Command.make(
  "report",
  {
    out: Flag.string("out").pipe(
      Flag.withDescription("Write the Markdown report to this file instead of stdout."),
      Flag.optional,
    ),
    ledger: ledgerFlag,
    repo: repoFlag,
    noFetch: noFetchFlag,
  },
  ({ out, ledger, repo, noFetch }) =>
    runReport({
      repoRoot: repo,
      ledgerPath: ledger,
      out: Option.getOrUndefined(out),
      fetch: !noFetch,
    }),
).pipe(Command.withDescription("Report the upstream changes we have not reviewed yet."));

const markCommand = Command.make(
  "mark",
  {
    upstream: Flag.string("upstream").pipe(
      Flag.withDescription("Upstream commit the decision applies to."),
    ),
    intent: Flag.string("intent").pipe(
      Flag.withDescription(
        "What the change does, in our vocabulary. Required for deferred and reimplemented, which are only actionable later if someone wrote the behaviour down.",
      ),
      Flag.optional,
    ),
    decision: Flag.choice("decision", UpstreamSyncDecision.literals).pipe(
      Flag.withDescription("What we did with the change."),
    ),
    ours: Flag.string("ours").pipe(
      Flag.withDescription("Our commit that carries the change, when there is one."),
      Flag.optional,
    ),
    reason: Flag.string("reason").pipe(
      Flag.withDescription("Why we decided this. Becomes the precedent later reviews read."),
    ),
    ledger: ledgerFlag,
    repo: repoFlag,
    noFetch: noFetchFlag,
  },
  ({ upstream, decision, ours, intent, reason, ledger, repo, noFetch }) =>
    runMark({
      repoRoot: repo,
      ledgerPath: ledger,
      upstream,
      decision,
      intent: Option.getOrUndefined(intent),
      ours: Option.getOrUndefined(ours),
      reason,
      fetch: !noFetch,
    }),
).pipe(Command.withDescription("Record one decision in the ledger and advance lastReviewed."));

const validateCommand = Command.make("validate", { ledger: ledgerFlag }, ({ ledger }) =>
  Effect.gen(function* () {
    const decoded = yield* readLedger(ledger);
    yield* Console.log(
      `${ledger} is valid: ${decoded.entries.length} entries, lastReviewed ${decoded.lastReviewed.slice(0, 9)}.`,
    );
  }),
).pipe(Command.withDescription("Check that the ledger matches its schema."));

/**
 * Checks the working tree for upstream leftovers a cherry-pick can introduce without conflicting.
 * Run it after every pick, not just the ones that conflicted.
 */

/**
 * Files that exist here and not upstream. Upstream prunes dependencies against its own tree, so
 * these are exactly the files whose imports no upstream reviewer ever sees.
 */
const listForkOnlyFiles = Effect.fn("listForkOnlyFiles")(function* (
  git: GitRunner,
  upstreamRef: string,
) {
  const upstreamTree = git.run(["ls-tree", "-r", "--name-only", upstreamRef]);
  if (upstreamTree.status !== 0) return null;
  const upstream = new Set(upstreamTree.stdout.split("\n").filter((line) => line.length > 0));
  return (
    (yield* gitOrFail(git, ["ls-files"]))
      .split("\n")
      .filter((line) => line.length > 0 && !upstream.has(line))
      // Test files carry code fixtures inside string literals, which read as imports and are not.
      .filter((line) => /\.(?:ts|tsx|mts|cts)$/u.test(line) && !/\.(?:test|spec)\./u.test(line))
  );
});

/**
 * The dependency names visible to a file: its own package's manifest plus the workspace root's.
 * Anything else would have to be hoisted by accident, which is the bug this looks for.
 */
const makeDeclaredLookup = Effect.fn("makeDeclaredLookup")(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const cache = new Map<string, ReadonlySet<string>>();

  const readManifest = Effect.fn("readManifest")(function* (dir: string) {
    const cached = cache.get(dir);
    if (cached) return cached;
    const raw = yield* fs
      .readFileString(`${repoRoot}/${dir === "" ? "" : `${dir}/`}package.json`)
      .pipe(Effect.orElseSucceed(() => ""));
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const declared = raw === "" ? new Set<string>() : collectDeclaredDependencies(JSON.parse(raw));
    cache.set(dir, declared);
    return declared;
  });

  const root = yield* readManifest("");
  const owners = new Map<string, ReadonlySet<string>>();

  return Effect.fn("declaredFor")(function* (path: string) {
    const segments = path.split("/");
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const dir = segments.slice(0, depth).join("/");
      const known = owners.get(dir);
      if (known) return known;
      const exists = yield* fs
        .exists(`${repoRoot}/${dir}/package.json`)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const declared = new Set([...(yield* readManifest(dir)), ...root]);
      owners.set(dir, declared);
      return declared as ReadonlySet<string>;
    }
    return root;
  });
});

export const runVerify = Effect.fn("runVerify")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const git = createGitRunner(options.repoRoot);
  const tracked = (yield* gitOrFail(git, ["ls-files"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const residue = [...findPathResidue(tracked)];
  for (const path of tracked.filter((candidate) =>
    /\.(?:ts|tsx|mts|cts|js|jsx)$/u.test(candidate),
  )) {
    const contents = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    residue.push(...findImportResidue(path, contents));
  }

  yield* Console.log(formatResidue(residue));

  const ledger = yield* readLedger(options.ledgerPath).pipe(Effect.orElseSucceed(() => null));
  const upstreamRef = ledger === null ? null : `${ledger.upstreamRemote}/${ledger.upstreamBranch}`;
  const forkOnly = upstreamRef === null ? null : yield* listForkOnlyFiles(git, upstreamRef);
  let undeclaredCount = 0;
  if (forkOnly === null) {
    yield* Console.log(
      "Skipped the fork-only dependency check: the upstream remote is not in this clone.",
    );
  } else {
    const declaredFor = yield* makeDeclaredLookup(options.repoRoot);
    const files: Array<{ path: string; contents: string }> = [];
    for (const path of forkOnly) {
      files.push({
        path,
        contents: yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => "")),
      });
    }
    const declaredByPath = new Map<string, ReadonlySet<string>>();
    for (const file of files) {
      declaredByPath.set(file.path, yield* declaredFor(file.path));
    }
    const undeclared = findUndeclaredForkDependencies(
      files,
      (path) => declaredByPath.get(path) ?? new Set<string>(),
    );
    undeclaredCount = undeclared.length;
    yield* Console.log(formatUndeclaredForkDependencies(undeclared));
  }

  if (residue.length > 0 || undeclaredCount > 0) {
    return yield* new UpstreamSyncGitError({ args: ["verify"], status: 1, stderr: "" });
  }
});

const verifyCommand = Command.make(
  "verify",
  { ledger: ledgerFlag, repo: repoFlag },
  ({ ledger, repo }) => runVerify({ repoRoot: repo, ledgerPath: ledger }),
).pipe(
  Command.withDescription(
    "Fail if the tree still names upstream, or if a fork-only file imports a package no manifest declares.",
  ),
);

interface GateStep {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The checks CI runs, in the order that fails cheapest first.
 *
 * `install --frozen-lockfile` leads because everything after it is a lie without it: a stale
 * `node_modules` still resolves a dependency the picks removed, so typecheck and tests pass here
 * and fail on a fresh checkout. `release:smoke` regenerates the lockfile from scratch, which is the
 * only place a patch orphaned by a version bump shows up.
 */
const gateSteps: ReadonlyArray<GateStep> = [
  { name: "install", command: "vp", args: ["install", "--frozen-lockfile"] },
  { name: "typecheck", command: "vp", args: ["run", "typecheck"] },
  { name: "lint", command: "vp", args: ["run", "lint"] },
  { name: "lint:mobile", command: "vp", args: ["run", "lint:mobile"] },
  { name: "release:smoke", command: "vp", args: ["run", "release:smoke"] },
  { name: "test", command: "vp", args: ["run", "test"] },
];

export const runGate = Effect.fn("runGate")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
  readonly quick: boolean;
}) {
  const skipped = new Set(options.quick ? ["release:smoke", "test"] : []);
  const steps = gateSteps.filter((step) => !skipped.has(step.name));

  yield* Console.log(`Running ${steps.length + 1} gate steps. Ctrl-C is safe: nothing is written.`);

  const install = steps[0];
  if (install !== undefined && install.name === "install") {
    yield* Console.log(`\n--- ${install.name} ---`);
    const started = Date.now();
    const result = NodeChildProcess.spawnSync(install.command, [...install.args], {
      cwd: options.repoRoot,
      stdio: "inherit",
    });
    yield* Console.log(`${install.name}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if ((result.status ?? 1) !== 0) {
      yield* Console.log(`\nGate stopped at ${install.name}.`);
      return yield* new UpstreamSyncGitError({ args: ["gate"], status: 1, stderr: "" });
    }
  }

  // After the install, so it reads the manifests the picks actually left behind.
  yield* Console.log("\n--- verify ---");
  yield* runVerify({ repoRoot: options.repoRoot, ledgerPath: options.ledgerPath });

  for (const step of steps.slice(1)) {
    yield* Console.log(`\n--- ${step.name} ---`);
    const started = Date.now();
    const result = NodeChildProcess.spawnSync(step.command, [...step.args], {
      cwd: options.repoRoot,
      stdio: "inherit",
    });
    yield* Console.log(`${step.name}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if ((result.status ?? 1) !== 0) {
      yield* Console.log(`\nGate stopped at ${step.name}.`);
      return yield* new UpstreamSyncGitError({ args: ["gate"], status: 1, stderr: "" });
    }
  }

  yield* Console.log("\nGate passed. Push.");
});

const gateCommand = Command.make(
  "gate",
  {
    ledger: ledgerFlag,
    repo: repoFlag,
    quick: Flag.boolean("quick").pipe(
      Flag.withDescription("Skip release:smoke and the full test run."),
      Flag.withDefault(false),
    ),
  },
  ({ ledger, repo, quick }) => runGate({ repoRoot: repo, ledgerPath: ledger, quick }),
).pipe(
  Command.withDescription(
    "Run the checks CI runs, once, before pushing a sync branch. Reinstalls from the lockfile first so a stale node_modules cannot hide a dependency the picks removed.",
  ),
);

export interface CommitAlignmentIssue {
  readonly path: string;
  readonly reason: string;
}

export interface CommitAlignment {
  readonly aligned: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<CommitAlignmentIssue>;
}

const parseChangedPaths = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status = "", upstreamPath = ""] = line.split("\t");
      return { status, upstreamPath, path: mapUpstreamPath(upstreamPath) };
    });

interface NormalizedMergeOutput {
  readonly path: string;
  readonly contents: string | null;
}

interface NormalizedMergePlan extends CommitAlignment {
  readonly outputs: ReadonlyArray<NormalizedMergeOutput>;
}

const formatNormalizedFile = (git: GitRunner, path: string, contents: string) => {
  const formatter = NodePath.join(git.repoRoot, "node_modules", ".bin", "vp");
  if (!NodeFS.existsSync(formatter)) return contents;
  const formatted = NodeChildProcess.spawnSync(
    formatter,
    ["fmt", `--stdin-filepath=${path}`, "--no-error-on-unmatched-pattern"],
    {
      cwd: git.repoRoot,
      encoding: "utf8",
      input: contents,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return formatted.status === 0 ? (formatted.stdout ?? contents) : contents;
};

const formatChangedPaths = Effect.fn("formatChangedPaths")(function* (
  git: GitRunner,
  paths: ReadonlyArray<string>,
) {
  const formatter = NodePath.join(git.repoRoot, "node_modules", ".bin", "vp");
  if (!NodeFS.existsSync(formatter)) return;
  const formatted = NodeChildProcess.spawnSync(
    formatter,
    ["fmt", ...new Set(paths), "--no-error-on-unmatched-pattern"],
    {
      cwd: git.repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (formatted.status !== 0) {
    return yield* new UpstreamSyncGitError({
      args: ["vp", "fmt"],
      status: formatted.status ?? 1,
      stderr: formatted.stderr ?? "",
    });
  }
});

const mergeNormalizedFile = (
  current: string,
  base: string,
  incoming: string,
): { readonly status: number; readonly contents: string } => {
  const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ras-upstream-merge-"));
  try {
    const currentPath = NodePath.join(temp, "current");
    const basePath = NodePath.join(temp, "base");
    const incomingPath = NodePath.join(temp, "incoming");
    NodeFS.writeFileSync(currentPath, current);
    NodeFS.writeFileSync(basePath, base);
    NodeFS.writeFileSync(incomingPath, incoming);
    const merged = NodeChildProcess.spawnSync(
      "git",
      ["merge-file", "-p", currentPath, basePath, incomingPath],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return { status: merged.status ?? 1, contents: merged.stdout ?? "" };
  } finally {
    NodeFS.rmSync(temp, { recursive: true, force: true });
  }
};

const buildNormalizedMergePlan = (git: GitRunner, sha: string): NormalizedMergePlan => {
  const changed = git.run(["diff", "--no-renames", "--name-status", `${sha}^`, sha]);
  if (changed.status !== 0) {
    return {
      aligned: false,
      paths: [],
      outputs: [],
      issues: [{ path: sha, reason: changed.stderr.trim() || "could not read changed paths" }],
    };
  }

  const binary = new Set(
    git
      .run(["diff", "--no-renames", "--numstat", `${sha}^`, sha])
      .stdout.split("\n")
      .filter((line) => line.startsWith("-\t-\t"))
      .map((line) => line.split("\t")[2] ?? ""),
  );
  const files = parseChangedPaths(changed.stdout);
  const issues: Array<CommitAlignmentIssue> = [];
  const outputs: Array<NormalizedMergeOutput> = [];

  for (const file of files) {
    if (file.upstreamPath.length === 0 || !["A", "M", "D"].includes(file.status)) {
      issues.push({
        path: file.path,
        reason: `unsupported git status ${file.status || "unknown"}`,
      });
      continue;
    }
    const policy = classifyPathPolicy(file.path);
    if (policy.kind !== "normal" && policy.kind !== "wire") {
      issues.push({ path: file.path, reason: policy.reason ?? `${policy.kind} path` });
      continue;
    }
    if (binary.has(file.upstreamPath)) {
      issues.push({ path: file.path, reason: "binary file" });
      continue;
    }

    const local = git.run(["show", `HEAD:${file.path}`]);
    if (file.status === "A") {
      if (local.status === 0) {
        issues.push({ path: file.path, reason: "upstream adds a path that already exists here" });
        continue;
      }
      const incoming = git.run(["show", `${sha}:${file.upstreamPath}`]);
      if (incoming.status !== 0) {
        issues.push({ path: file.path, reason: "could not read the upstream addition" });
        continue;
      }
      outputs.push({
        path: file.path,
        contents: formatNormalizedFile(git, file.path, rebrandText(incoming.stdout)),
      });
      continue;
    }
    if (local.status !== 0) {
      issues.push({ path: file.path, reason: "mapped path does not exist here" });
      continue;
    }
    const parent = git.run(["show", `${sha}^:${file.upstreamPath}`]);
    if (parent.status !== 0) {
      issues.push({ path: file.path, reason: "could not read the upstream parent" });
      continue;
    }
    const incoming =
      file.status === "D"
        ? { status: 0, stdout: "" }
        : git.run(["show", `${sha}:${file.upstreamPath}`]);
    if (incoming.status !== 0) {
      issues.push({ path: file.path, reason: "could not read the upstream result" });
      continue;
    }

    const merged = mergeNormalizedFile(
      local.stdout,
      formatNormalizedFile(git, file.path, rebrandText(parent.stdout)),
      formatNormalizedFile(git, file.path, rebrandText(incoming.stdout)),
    );
    if (merged.status !== 0) {
      issues.push({ path: file.path, reason: "normalized three-way merge conflicts" });
      continue;
    }
    outputs.push({
      path: file.path,
      contents: file.status === "D" && merged.contents.length === 0 ? null : merged.contents,
    });
  }

  return {
    aligned: issues.length === 0,
    paths: files.map((file) => file.path),
    outputs,
    issues,
  };
};

/**
 * A commit is mechanically adoptable when its normalized three-way merge does not overlap a fork
 * edit. This is the same boundary a human would use, without spending a review on unrelated lines.
 */
export function inspectCommitAlignment(git: GitRunner, sha: string): CommitAlignment {
  const { outputs: _outputs, ...alignment } = buildNormalizedMergePlan(git, sha);
  return alignment;
}

/** Applies one upstream commit after rewriting its paths and product vocabulary. */
export const applyRebrandedCommit = Effect.fn("applyRebrandedCommit")(function* (
  git: GitRunner,
  sha: string,
  paths: ReadonlyArray<string>,
) {
  const patch = yield* gitOrFail(git, [
    "diff",
    "--no-renames",
    "--binary",
    "--full-index",
    `${sha}^`,
    sha,
  ]);
  const rebrandedPatch = rebrandPatch(patch);
  const appliesDirectly = git.run(["apply", "--check", "--whitespace=nowarn", "-"], rebrandedPatch);
  if (appliesDirectly.status === 0) {
    yield* gitWithInputOrFail(git, ["apply", "--whitespace=nowarn", "-"], rebrandedPatch);
  } else {
    const plan = buildNormalizedMergePlan(git, sha);
    if (!plan.aligned) {
      return yield* new UpstreamSyncGitError({
        args: ["normalized-merge", sha],
        status: 1,
        stderr: plan.issues.map((issue) => `${issue.path}: ${issue.reason}`).join("\n"),
      });
    }
    for (const output of plan.outputs) {
      const absolutePath = NodePath.join(git.repoRoot, output.path);
      if (output.contents === null) {
        NodeFS.rmSync(absolutePath);
      } else {
        NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
        NodeFS.writeFileSync(absolutePath, output.contents);
      }
    }
  }
  yield* formatChangedPaths(git, paths);
  yield* gitOrFail(git, ["add", "--all", "--", ...new Set(paths)]);

  const originalMessage = yield* gitOrFail(git, ["show", "-s", "--format=%B", sha]);
  const [authorName = "", authorEmail = "", authorDate = ""] = (yield* gitOrFail(git, [
    "show",
    "-s",
    "--format=%an%x00%ae%x00%aI",
    sha,
  ]))
    .trim()
    .split("\0");
  const message = `${originalMessage.trimEnd()}\n\n(cherry picked from commit ${sha})\n`;
  yield* gitWithInputOrFail(
    git,
    ["commit", `--author=${authorName} <${authorEmail}>`, `--date=${authorDate}`, "-F", "-"],
    message,
  );
  return (yield* gitOrFail(git, ["rev-parse", "HEAD"])).trim();
});

const ensureCleanWorktree = (git: GitRunner) => {
  const status = git.run(["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.length > 0) {
    return Effect.fail(
      new UpstreamSyncGitError({
        args: ["status", "--porcelain"],
        status: status.status === 0 ? 1 : status.status,
        stderr: status.stdout || status.stderr,
      }),
    );
  }
  return Effect.void;
};

export const runAdoptAligned = Effect.fn("runAdoptAligned")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
  readonly fetch: boolean;
  readonly dryRun: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const git = createGitRunner(options.repoRoot);
  yield* ensureCleanWorktree(git);
  let ledger = yield* readLedger(options.ledgerPath);

  if (options.fetch) {
    yield* gitOrFail(git, ["fetch", ledger.upstreamRemote, ledger.upstreamBranch]);
  }

  const pending = yield* listUpstreamCommits(git, upstreamRange(ledger));
  if (pending.length === 0) {
    yield* Console.log("No pending upstream commits.");
    return;
  }

  const adopted: Array<{ upstream: UpstreamCommit; ours: string }> = [];
  for (const commit of pending) {
    const alignment = inspectCommitAlignment(git, commit.sha);
    if (!alignment.aligned) {
      yield* Console.log(
        [
          `${commit.sha.slice(0, 9)} needs review: ${commit.subject}`,
          ...alignment.issues.slice(0, 8).map((issue) => `- ${issue.path}: ${issue.reason}`),
          alignment.issues.length > 8 ? `- and ${alignment.issues.length - 8} more` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
      break;
    }
    if (options.dryRun) {
      yield* Console.log(`${commit.sha.slice(0, 9)} can be adopted without review.`);
      return;
    }

    yield* Console.log(`Adopting aligned commit ${commit.sha.slice(0, 9)}: ${commit.subject}`);
    const ours = yield* applyRebrandedCommit(git, commit.sha, alignment.paths);
    yield* runVerify({ repoRoot: options.repoRoot, ledgerPath: options.ledgerPath });
    adopted.push({ upstream: commit, ours });
  }

  if (adopted.length === 0) return;
  const pendingShas = pending.map((commit) => commit.sha);
  for (const { upstream, ours } of adopted) {
    const change = groupCommitsByPullRequest([upstream])[0]!;
    ledger = recordDecision(
      ledger,
      {
        upstream: upstream.sha,
        pr: change.pr,
        title: change.title,
        decision: "adopted",
        ours,
        reason: "Auto-adopted because its normalized three-way merge did not overlap fork edits.",
        reviewedAt: new Date().toISOString(),
      },
      pendingShas,
    );
  }
  yield* fs.writeFileString(options.ledgerPath, encodeUpstreamSyncLedger(ledger));
  yield* gitOrFail(git, ["add", "--", options.ledgerPath]);
  yield* gitOrFail(git, [
    "commit",
    "-m",
    `chore(upstream): record aligned changes through ${ledger.lastReviewed.slice(0, 9)}`,
  ]);
  yield* Console.log(
    `Adopted ${adopted.length} aligned commit${adopted.length === 1 ? "" : "s"}; stopped before the first fork divergence.`,
  );
});

const adoptAlignedCommand = Command.make(
  "adopt-aligned",
  {
    ledger: ledgerFlag,
    repo: repoFlag,
    noFetch: noFetchFlag,
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Check the next commit without changing the repository."),
      Flag.withDefault(false),
    ),
  },
  ({ ledger, repo, noFetch, dryRun }) =>
    runAdoptAligned({
      repoRoot: repo,
      ledgerPath: ledger,
      fetch: !noFetch,
      dryRun,
    }),
).pipe(
  Command.withDescription(
    "Adopt the leading run of upstream commits whose normalized three-way merges do not overlap fork edits.",
  ),
);

/**
 * Applies a run of already-judged changes, rebranding each and checking only what is cheap.
 *
 * The expensive checks are the reason a sync takes hours: half of a round's changes are clean
 * cherry-picks, and running a typecheck and a test pass after each one costs far more than it ever
 * catches. `verify` is under a second, so it stays per pick; typecheck and tests move to `gate`,
 * once, at the end. A batch stops at the first conflict, so the run that needs hands is the one
 * left in the working tree.
 */
export const runBatch = Effect.fn("runBatch")(function* (options: {
  readonly repoRoot: string;
  readonly ledgerPath: string;
  readonly shas: ReadonlyArray<string>;
}) {
  const git = createGitRunner(options.repoRoot);
  const applied: Array<string> = [];

  for (const sha of options.shas) {
    yield* Console.log(`\n--- ${sha.slice(0, 9)} ---`);
    const paths = listCommitFiles(git, sha).pipe(
      Effect.map((files) => files.map((file) => file.path)),
    );
    const picked = yield* applyRebrandedCommit(git, sha, yield* paths).pipe(Effect.result);
    if (picked._tag === "Failure") {
      yield* Console.log(
        [
          `${sha.slice(0, 9)} does not apply after mechanical rebranding, so the batch stops here.`,
          "Pick it by hand, decide it, then start another batch after it.",
          applied.length === 0 ? "" : `Applied before it: ${applied.length}.`,
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
      return { applied, stoppedAt: sha } as const;
    }

    const residue = yield* runVerify({
      repoRoot: options.repoRoot,
      ledgerPath: options.ledgerPath,
    }).pipe(Effect.result);
    if (residue._tag === "Failure") {
      yield* Console.log(
        `${sha.slice(0, 9)} applied but left upstream residue. Fix it here before continuing.`,
      );
      return { applied, stoppedAt: sha } as const;
    }
    applied.push(sha);
  }

  yield* Console.log(
    [
      `\nApplied ${applied.length} change${applied.length === 1 ? "" : "s"}.`,
      "Now run `node scripts/upstream-sync.ts gate` once, then `mark` each change.",
    ].join("\n"),
  );
  return { applied, stoppedAt: null } as const;
});

const batchCommand = Command.make(
  "batch",
  {
    ledger: ledgerFlag,
    repo: repoFlag,
    shas: Flag.string("sha").pipe(
      Flag.withDescription("An upstream commit to apply. Repeat, in upstream history order."),
      (flag) => Flag.atLeast(flag, 1),
    ),
  },
  ({ ledger, repo, shas }) =>
    runBatch({ repoRoot: repo, ledgerPath: ledger, shas }).pipe(Effect.asVoid),
).pipe(
  Command.withDescription(
    "Cherry-pick a run of changes you have already judged, checking only `verify` per pick. Stops at the first conflict. Run `gate` once afterwards, not per pick.",
  ),
);

const upstreamSyncCommand = Command.make("upstream-sync", {}, () =>
  runReport({
    repoRoot: ".",
    ledgerPath: UPSTREAM_SYNC_LEDGER_PATH,
    out: undefined,
    fetch: true,
  }),
).pipe(
  Command.withDescription("Track upstream changes and record what we did with them."),
  Command.withSubcommands([
    reportCommand,
    markCommand,
    validateCommand,
    verifyCommand,
    gateCommand,
    adoptAlignedCommand,
    batchCommand,
  ]),
);

if (import.meta.main) {
  Command.run(upstreamSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
