/**
 * Ledger schema and classification helpers for the upstream sync workflow.
 *
 * The ledger at `upstream/sync.json` records what we did with every upstream change since the fork
 * point, so `lastReviewed` never advances past something nobody decided on.
 */

import * as Schema from "effect/Schema";

import { mapUpstreamPath } from "./upstreamRebrandMap.ts";

export const UPSTREAM_SYNC_LEDGER_PATH = "upstream/sync.json";

export const UpstreamSyncDecision = Schema.Literals([
  "adopted",
  "adapted",
  "reimplemented",
  "obsolete",
  "skipped",
  "deferred",
]);
export type UpstreamSyncDecision = typeof UpstreamSyncDecision.Type;

export const UpstreamSyncEntry = Schema.Struct({
  upstream: Schema.String.check(Schema.isNonEmpty()),
  pr: Schema.NullOr(Schema.Number),
  title: Schema.String,
  decision: UpstreamSyncDecision,
  ours: Schema.NullOr(Schema.String),
  /**
   * What the change does, in our vocabulary rather than upstream's paths. A `deferred` or
   * `reimplemented` entry is only actionable later if someone wrote down the behaviour, because the
   * diff stops applying long before the intent stops mattering.
   */
  intent: Schema.optional(Schema.String),
  reason: Schema.String,
  reviewedAt: Schema.String,
});
export type UpstreamSyncEntry = typeof UpstreamSyncEntry.Type;

export const UpstreamSyncLedger = Schema.Struct({
  upstreamRemote: Schema.String.check(Schema.isNonEmpty()),
  upstreamBranch: Schema.String.check(Schema.isNonEmpty()),
  forkPoint: Schema.String.check(Schema.isNonEmpty()),
  lastReviewed: Schema.String.check(Schema.isNonEmpty()),
  entries: Schema.Array(UpstreamSyncEntry),
});
export type UpstreamSyncLedger = typeof UpstreamSyncLedger.Type;

const decodeLedger = Schema.decodeSync(Schema.fromJsonString(UpstreamSyncLedger));
const encodeLedger = Schema.encodeSync(Schema.fromJsonString(UpstreamSyncLedger));

/** Decodes ledger JSON. Throws a schema error naming the offending field when the file is invalid. */
export function decodeUpstreamSyncLedger(raw: string): UpstreamSyncLedger {
  return decodeLedger(raw);
}

/** Encodes a ledger back to the on-disk shape: validated, pretty-printed, newline-terminated. */
export function encodeUpstreamSyncLedger(ledger: UpstreamSyncLedger): string {
  return `${JSON.stringify(JSON.parse(encodeLedger(ledger)), null, 2)}\n`;
}

export const UpstreamChangeArea = Schema.Literals([
  "server",
  "web",
  "mobile",
  "desktop",
  "contracts",
  "shared",
  "docs",
  "ci",
  "other",
]);
export type UpstreamChangeArea = typeof UpstreamChangeArea.Type;

const areaPrefixes: ReadonlyArray<readonly [string, UpstreamChangeArea]> = [
  ["apps/server/", "server"],
  ["apps/web/", "web"],
  ["apps/mobile/", "mobile"],
  ["apps/desktop/", "desktop"],
  ["packages/contracts/", "contracts"],
  ["packages/shared/", "shared"],
  ["packages/client-runtime/", "shared"],
  ["docs/", "docs"],
  [".github/", "ci"],
];

/** Buckets one repository path into the area an agent reasons about. */
export function classifyArea(path: string): UpstreamChangeArea {
  const match = areaPrefixes.find(([prefix]) => path.startsWith(prefix));
  return match ? match[1] : "other";
}

/** Areas hit by a change, in the fixed order above so report rows stay comparable. */
export function summarizeAreas(paths: ReadonlyArray<string>): ReadonlyArray<UpstreamChangeArea> {
  const hit = new Set(paths.map(classifyArea));
  return UpstreamChangeArea.literals.filter((area) => hit.has(area));
}

export type UpstreamPathPolicyKind = "wire" | "replaced" | "removed" | "diverged" | "normal";

export interface UpstreamPathPolicy {
  readonly kind: UpstreamPathPolicyKind;
  readonly reason: string | null;
}

const NORMAL_POLICY: UpstreamPathPolicy = { kind: "normal", reason: null };

const replacedPrefixes: ReadonlyArray<readonly [string, string]> = [
  ["apps/marketing/", "apps/marketing, which we replaced"],
  ["assets/", "brand assets, which we replaced"],
  ["apps/web/public/", "brand assets, which we replaced"],
  ["apps/mobile/assets/", "brand assets, which we replaced"],
  ["apps/desktop/build/", "brand assets, which we replaced"],
  ["packaging/", "packaging metadata, which we renamed"],
];

const THEME_EDITOR = "the custom theme editor, which we removed";
const LEGACY_SURFACES = "the legacy sidebar and plan mode, which we removed";

/**
 * Surfaces we deleted outright. A change that only touches these has nothing to land against, so it
 * is `obsolete` rather than skipped: skipping implies a judgement, obsolete states a fact.
 */
const PROJECT_ICON_PICKER =
  "the named project-icon picker, which we replaced with emoji and favicons";

const removedPrefixes: ReadonlyArray<readonly [string, string]> = [
  ["experiments/", "experiments, which we do not carry"],
  [".macroscope/", "Macroscope review configuration, which we do not carry"],
  [".coderabbit.yaml", "CodeRabbit review configuration, which we do not carry"],
  [".github/VOUCHED.td", "upstream's contributor trust list, which we do not inherit"],
  // Legacy surfaces removed in #23: the per-project sidebar tree and plan mode.
  ["apps/web/src/components/LegacySidebar", LEGACY_SURFACES],
  ["apps/mobile/src/features/threads/thread-list-items", LEGACY_SURFACES],
  ["apps/mobile/src/features/threads/threadPresentation", LEGACY_SURFACES],
  ["apps/mobile/src/features/threads/use-thread-list-v2-enabled", LEGACY_SURFACES],
  ["apps/mobile/src/features/home/homeListItems", LEGACY_SURFACES],
  ["apps/mobile/src/features/threads/legacy-plan-mode", LEGACY_SURFACES],
  ["apps/mobile/src/features/threads/use-legacy-plan-mode-enabled", LEGACY_SURFACES],
  ["apps/mobile/generated-uniwind-themes.css", "the generated mobile theme artifact we removed"],
  // The named project-icon picker, replaced in #52 by a saved emoji plus the project favicon, so
  // there is no project-name-derived icon to change.
  ["apps/web/src/projectIconModel", PROJECT_ICON_PICKER],
  ["apps/web/src/components/settings/ProjectIconPickerDialog", PROJECT_ICON_PICKER],
  // The custom theme editor and its VS Code / OpenVSX theme import, removed in
  // #51 in favour of the fixed theme set.
  ["apps/web/src/components/settings/ThemeColorPicker", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemeEditor", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemeImportDialog", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemePreviewCircles", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemeSearchSection", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemeSettings", THEME_EDITOR],
  ["apps/web/src/components/settings/ThemeWireframe", THEME_EDITOR],
  ["apps/web/src/components/settings/themeEditorStore", THEME_EDITOR],
  ["apps/web/src/components/settings/themeInspector", THEME_EDITOR],
  ["apps/web/src/hooks/useCustomThemes", THEME_EDITOR],
  ["apps/web/src/hooks/useDefaultTheme", THEME_EDITOR],
  ["apps/web/src/hooks/useEnvironmentTheme", THEME_EDITOR],
  ["apps/web/src/openVsxThemes", THEME_EDITOR],
  ["apps/web/src/vscodeThemeImport", THEME_EDITOR],
  ["docs/user/environment-theme.md", THEME_EDITOR],
];

/**
 * Surfaces we deliberately built differently and intend to keep that way. A patch here will not
 * apply and should not be forced; take the behaviour and rebuild it in our shape.
 *
 * Only list a surface once we have decided *not* to converge. Somewhere we are merely behind, or
 * mid-migration toward upstream's design, does not belong here — that is a deferred change with an
 * intent, not a standing divergence. Keep entries short and specific: a prefix here turns off
 * cherry-picking for everything beneath it.
 */
const divergedPrefixes: ReadonlyArray<readonly [string, string]> = [];

const brandAssetExtensions = [".png", ".svg", ".ico", ".icns", ".webp", ".jpg", ".jpeg"];

/**
 * Says whether a mapped path lands somewhere we deliberately keep aligned with upstream (`wire`) or
 * somewhere we already replaced (`replaced`). Everything else is `normal`.
 */
export function classifyPathPolicy(path: string): UpstreamPathPolicy {
  if (path.startsWith("packages/contracts/")) {
    return { kind: "wire", reason: "wire contract we keep compatible with upstream" };
  }
  const removed = removedPrefixes.find(([prefix]) => path.startsWith(prefix));
  if (removed) {
    return { kind: "removed", reason: `touches ${removed[1]}` };
  }
  const replaced = replacedPrefixes.find(([prefix]) => path.startsWith(prefix));
  if (replaced) {
    return { kind: "replaced", reason: `touches ${replaced[1]}` };
  }
  const diverged = divergedPrefixes.find(([prefix]) => path.startsWith(prefix));
  if (diverged) {
    return { kind: "diverged", reason: `touches ${diverged[1]}` };
  }
  if (brandAssetExtensions.some((extension) => path.endsWith(extension))) {
    return { kind: "replaced", reason: "touches brand assets, which we replaced" };
  }
  if (/(^|\/)(legal|privacy|terms)(\/|[.-])/i.test(path)) {
    return { kind: "replaced", reason: "touches legal pages, which we replaced" };
  }
  return NORMAL_POLICY;
}

export interface UpstreamCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface UpstreamChange {
  /** Stable identifier: `pr-<number>` when the subject names one, otherwise the commit sha. */
  readonly key: string;
  readonly pr: number | null;
  readonly title: string;
  readonly commits: ReadonlyArray<UpstreamCommit>;
}

/** Reads the trailing `(#1234)` GitHub squash marker off a commit subject. */
export function parsePullRequestNumber(subject: string): number | null {
  const match = /\(#(\d+)\)\s*$/.exec(subject);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/**
 * Groups first-parent commits into reviewable changes: one per pull request, and one per commit for
 * anything pushed without a pull request. Input and output stay in upstream history order.
 */
export function groupCommitsByPullRequest(
  commits: ReadonlyArray<UpstreamCommit>,
): ReadonlyArray<UpstreamChange> {
  const changes: Array<UpstreamChange & { commits: Array<UpstreamCommit> }> = [];
  const byPullRequest = new Map<number, (typeof changes)[number]>();

  for (const commit of commits) {
    const pr = parsePullRequestNumber(commit.subject);
    const existing = pr === null ? undefined : byPullRequest.get(pr);
    if (existing) {
      existing.commits.push(commit);
      continue;
    }
    const change = {
      key: pr === null ? commit.sha : `pr-${pr}`,
      pr,
      title: commit.subject.replace(/\s*\(#\d+\)\s*$/, ""),
      commits: [commit],
    };
    changes.push(change);
    if (pr !== null) {
      byPullRequest.set(pr, change);
    }
  }

  return changes;
}

export type SuggestedAction = "adopt" | "adapt" | "reimplement" | "obsolete" | "skip";

export interface ActionSuggestion {
  readonly action: SuggestedAction;
  readonly reason: string;
}

/** Turns the path signals into the opening position an agent then argues with. */
export function suggestAction(paths: ReadonlyArray<string>): ActionSuggestion {
  const policies = paths.map(classifyPathPolicy);
  const replaced = policies.filter((policy) => policy.kind === "replaced");
  const removed = policies.filter((policy) => policy.kind === "removed");
  const diverged = policies.filter((policy) => policy.kind === "diverged");

  if (policies.length > 0 && removed.length === policies.length) {
    return { action: "obsolete", reason: removed[0]!.reason ?? "touches surfaces we removed" };
  }
  if (diverged.length > 0) {
    return {
      action: "reimplement",
      reason: diverged[0]!.reason ?? "touches a surface we redesigned",
    };
  }
  if (policies.length > 0 && replaced.length === policies.length) {
    return { action: "skip", reason: replaced[0]!.reason ?? "touches replaced surfaces" };
  }
  if (replaced.length > 0) {
    return { action: "adapt", reason: `partly ${replaced[0]!.reason}` };
  }
  if (policies.some((policy) => policy.kind === "wire")) {
    return { action: "adopt", reason: "keep the wire protocol names unchanged" };
  }
  return { action: "adopt", reason: "ordinary source we track with upstream" };
}

/**
 * Advances `lastReviewed` across the longest prefix of `pending` (oldest first) that now has ledger
 * entries. It stops at the first undecided commit, so an out-of-order decision never buries one.
 */
export function advanceLastReviewed(
  ledger: UpstreamSyncLedger,
  pending: ReadonlyArray<string>,
): string {
  const decided = new Set(ledger.entries.map((entry) => entry.upstream));
  let reviewed = ledger.lastReviewed;
  for (const sha of pending) {
    if (!decided.has(sha)) {
      break;
    }
    reviewed = sha;
  }
  return reviewed;
}

/**
 * Adds one decision and re-advances `lastReviewed`. Entries stay in upstream history order, and an
 * existing decision for the same commit is replaced rather than duplicated.
 */
export function recordDecision(
  ledger: UpstreamSyncLedger,
  entry: UpstreamSyncEntry,
  pending: ReadonlyArray<string>,
): UpstreamSyncLedger {
  const rank = new Map(pending.map((sha, index) => [sha, index] as const));
  const kept = ledger.entries.filter((existing) => existing.upstream !== entry.upstream);
  const settled = kept.filter((existing) => !rank.has(existing.upstream));
  const ordered = [...kept.filter((existing) => rank.has(existing.upstream)), entry].sort(
    (left, right) => (rank.get(left.upstream) ?? 0) - (rank.get(right.upstream) ?? 0),
  );

  const next = { ...ledger, entries: [...settled, ...ordered] };
  return { ...next, lastReviewed: advanceLastReviewed(next, pending) };
}

/** Convenience wrapper so callers work in our vocabulary without importing the rebrand map. */
export function mapUpstreamPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return paths.map(mapUpstreamPath);
}
