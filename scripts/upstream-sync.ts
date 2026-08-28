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

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { mapUpstreamPath } from "./lib/upstreamRebrandMap.ts";
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
  readonly run: (args: ReadonlyArray<string>) => GitResult;
  readonly repoRoot: string;
}

export function createGitRunner(repoRoot: string): GitRunner {
  return {
    repoRoot,
    run: (args) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
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

export function renderReport(input: {
  readonly ledger: UpstreamSyncLedger;
  readonly upstreamHead: string;
  readonly reports: ReadonlyArray<ChangeReport>;
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
  ({ upstream, decision, ours, reason, ledger, repo, noFetch }) =>
    runMark({
      repoRoot: repo,
      ledgerPath: ledger,
      upstream,
      decision,
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

const upstreamSyncCommand = Command.make("upstream-sync", {}, () =>
  runReport({
    repoRoot: ".",
    ledgerPath: UPSTREAM_SYNC_LEDGER_PATH,
    out: undefined,
    fetch: true,
  }),
).pipe(
  Command.withDescription("Track upstream changes and record what we did with them."),
  Command.withSubcommands([reportCommand, markCommand, validateCommand]),
);

if (import.meta.main) {
  Command.run(upstreamSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
