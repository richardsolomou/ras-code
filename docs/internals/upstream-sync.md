# Upstream sync

> For maintainers. Using RAS Code? See [docs/user](../user/).

RAS Code is a diverging fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). We do not merge upstream. Changes on upstream-owned paths are adopted automatically until they overlap a fork edit; every remaining change is reviewed on the real code diff. Both paths record one ledger decision per upstream commit.

We want the improvements upstream makes. We do not want their repository structure, feature set, or release cadence. Those goals separate as the fork moves, so the unit of work is the change an upstream author made, not the patch they wrote. A cherry-pick is a shortcut that holds while a file still means the same thing in both trees; when it stops holding, we port the behavior instead. Neither forcing the patch nor dropping the improvement is acceptable.

The agent-facing procedure lives in the [`upstream-sync` skill](../../.agents/skills/upstream-sync/SKILL.md). This page describes the machinery it drives.

## The ledger

`upstream/sync.json` is the record of everything decided since the fork point.

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `upstreamRemote` | Git remote that points at upstream. RAS Code names this `t3code`.                  |
| `upstreamBranch` | Branch we track on that remote.                                                    |
| `forkPoint`      | Upstream commit this fork branched from.                                           |
| `lastReviewed`   | Newest upstream commit that, together with every commit before it, has a decision. |
| `entries`        | One decision per upstream commit, in upstream history order.                       |

Each entry records `upstream` (the commit), `pr` (the pull request number, or `null` for a commit pushed without one), `title`, `decision`, `ours` (our commit that carries the change, or `null`), `intent` (optional), `reason`, and `reviewedAt`.

`intent` is what the change does, written in our vocabulary rather than upstream's paths. It matters because a diff stops applying long before the intent stops mattering: once the surrounding code has moved, the sha alone is not enough to act on. Record it whenever the code did not come across verbatim, and always for `deferred` and `reimplemented`.

`decision` is one of:

- `adopted` — taken as-is, modulo the rebrand substitutions.
- `adapted` — the patch landed, with conflicts resolved in our favor where they touched our shape.
- `reimplemented` — the patch could not land, so we built the behavior ourselves. We have the improvement; we did not copy the code.
- `obsolete` — the surface no longer exists here, so there was nothing to decide. A fact, not a judgement.
- `skipped` — deliberately not taken. The `reason` becomes precedent.
- `deferred` — wanted, not landed yet. Stays visible for a later pass, and needs an `intent` to be actionable.

The schema is an Effect Schema in [`scripts/lib/upstreamSync.ts`](../../scripts/lib/upstreamSync.ts). `node scripts/upstream-sync.ts validate` checks the file against it.

`lastReviewed` only ever advances across the leading run of commits that have entries. Deciding a later change before an earlier one is fine; it just does not move the marker past the undecided one.

## The surface map

`scripts/lib/upstreamSync.ts` declares what an upstream path means here, so the report can say "there is nothing to land" instead of producing a conflict nobody can resolve:

| Kind       | Meaning                                                   | Suggests      |
| ---------- | --------------------------------------------------------- | ------------- |
| `wire`     | Kept compatible with upstream on purpose.                 | `adopt`       |
| `replaced` | We substituted our own surface (brand, marketing, legal). | `skip`        |
| `removed`  | We deleted the surface outright.                          | `obsolete`    |
| `diverged` | We built it differently and intend to keep it that way.   | `reimplement` |
| `normal`   | Ordinary source we still track with upstream.             | `adopt`       |

Add entries as we move and delete code — the map is what keeps the report useful once paths stop lining up.

One rule keeps `diverged` from rotting: **a surface we are migrating toward is not a divergence.** It is for designs we have decided to keep different, permanently. Somewhere we are behind upstream, or mid-migration onto their design, is a deferred change with an intent. Listing it as diverged turns off cherry-picking for that whole subtree and quietly commits us to maintaining a fork of it forever.

## Verifying a pick

```bash
node scripts/upstream-sync.ts verify
```

A cherry-pick that reports no conflict can still leave the tree wrong, because git only reports overlapping edits. `verify` fails when the tree still names upstream: package scopes (`@t3tools/...`) surviving in files no conflict touched, identifier namespaces (`"t3.mobile.connection-runtime"`, `"t3/provider/OpenCodeServerOwner"`) surviving inside string literals, or upstream directory names arriving as new paths. These compile-break, resurrect upstream's layout, or never surface at all, and none of them shows up until a full typecheck runs — usually several changes later.

It also fails when a **fork-only** file — one that exists here and not upstream — imports a package no manifest declares any more. Upstream prunes dependencies against upstream's own code, so a removal that is correct there can still be wrong here: #9150 dropped `@effect/platform-node-shared`, which only the fork-only relay connector imports. The pick was read and adapted, and nothing failed until `node_modules` was reinstalled from the merged lockfile, one CI round-trip later. The check skips test files, whose string fixtures contain code that reads as imports and is not.

It exempts the rebrand map and its fixtures, which name upstream deliberately. A bare `grep | xargs` over the tree does not, and rewriting them breaks the map.

`verify` runs in under a second, so it belongs after every pick. Typecheck and tests do not: half of a round is clean cherry-picks, and per-pick compilation costs far more than it catches. Those move to `gate`.

## Batching picks

```bash
node scripts/upstream-sync.ts batch --sha <a> --sha <b>
```

Rewrites paths and vocabulary before applying a run of already-judged changes. If a patch does not apply directly, the command merges our file against rebranded upstream snapshots, retrying with formatted snapshots only when needed. When `mergiraf` is installed, `batch` also resolves syntax-level overlaps such as independent imports or object fields. This removes mechanical conflicts without extending unattended `adopt-aligned` beyond textually non-overlapping changes. It runs `verify` after every commit and stops when behavior really overlaps.

## Adopting aligned changes

```bash
node scripts/upstream-sync.ts adopt-aligned
node scripts/upstream-sync.ts adopt-aligned --dry-run
```

`adopt-aligned` processes the pending history prefix without an agent reading clean diffs. A change qualifies when every path is classified `normal` or `wire` and its normalized three-way merge has no conflicts. The command applies and formats each qualifying commit, runs `verify`, records it as adopted, and commits the ledger before stopping at the first real fork overlap.

This is an ownership rule, not a heuristic. `normal` means we follow upstream on that source; paths we do not follow must be classified as `replaced`, `removed`, or `diverged`. New upstream files are therefore adopted automatically only on surfaces the map says upstream owns.

## The gate

```bash
node scripts/upstream-sync.ts gate
node scripts/upstream-sync.ts gate --quick   # skip release:smoke and the full test run
```

Runs what CI runs, once, before pushing: `install --frozen-lockfile`, `verify`, typecheck, lint, the mobile native static check, `release:smoke`, and the test suite, stopping at the first failure.

The install leads deliberately. Everything after it is a lie without it — a stale `node_modules` still resolves a dependency the picks removed, which is how a broken tree typechecks locally and fails on a fresh checkout. `release:smoke` matters for the same reason in reverse: it regenerates the lockfile from scratch, which is the only place a patch orphaned by a version bump inside its range shows up.

## The report

```bash
node scripts/upstream-sync.ts report            # Markdown on stdout
node scripts/upstream-sync.ts report --out report.md
node scripts/upstream-sync.ts report --no-fetch  # skip the fetch
```

The report fetches the `t3code` remote, lists the first-parent commits in `lastReviewed..t3code/main`, and groups them by the `(#1234)` marker in the subject. Commits without one are their own change. We avoid the conventional name `upstream` because RAS Code treats that name as the canonical repository identity when grouping projects and presenting repository names.

For each change it reports the files touched with our path mapping applied, the areas hit, the paths that land on surfaces we keep compatible or replaced, the files we already changed since the fork point, and the `git show` command to read the diff.

It closes with the brand tokens the rebrand table cannot decide anywhere in the range, most frequent first, so the table gets extended once before picking starts. Left to the per-file helper these arrive one at a time, mid-pick: the round through `70cd258d8` carried 63 distinct undecided tokens and spent seven commits teaching the map after the fact.

The report is an index, not a judgement. It says where a change lands, never whether it belongs here. There is deliberately no conflict prediction: the agent cherry-picks and resolves whatever git actually reports.

## The rebrand helper

[`scripts/lib/upstreamRebrandMap.ts`](../../scripts/lib/upstreamRebrandMap.ts) is the single source of truth for the fork's vocabulary: `@t3tools/*` to `@ras-code/*`, `T3CODE_*` to `RAS_CODE_*`, `T3 Code` to `RAS Code`, the mobile native module directories, and the rest. It also holds the do-not-rename list, which is matched first and copied through untouched.

```bash
node scripts/upstream-rebrand.ts <files>      # rewrite files in place
node scripts/upstream-rebrand.ts --patch      # rewrite a diff on stdin
```

The helper is assistive. It turns mechanical brand differences into a clean apply, and prints the brand tokens it could not decide so a human resolves them.

### Never renamed

Wire protocol names crossing the WebSocket, `/.well-known/t3/environment`, `refs/t3/checkpoints`, the legacy theme ids `t3-chat` and `t3-chat-dark`, and links to `pingdotgg/t3code`.

## Recording a decision

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision adapted \
  --ours "$(git rev-parse HEAD)" --reason "Ported the fix; kept our toast styling."
```

`mark` resolves the commit, reads its pull request number and title from upstream, inserts the entry in history order, and re-advances `lastReviewed`. Do not edit `lastReviewed` by hand.

## Decision policy

- Marketing, legal, and branding changes are skipped. We replaced those surfaces.
- Wire contracts stay compatible with upstream. Adopt contract changes and leave the protocol names alone.
- UI changes are adapted into our console grammar rather than copied verbatim. See [`apps/web/DESIGN.md`](../../apps/web/DESIGN.md) and [`apps/web/PRODUCT.md`](../../apps/web/PRODUCT.md).
- Never `git merge t3code/main`. The fork diverges on purpose.
