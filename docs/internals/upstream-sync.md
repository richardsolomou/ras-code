# Upstream sync

> For maintainers. Using RAS Code? See [docs/user](../user/).

RAS Code is a diverging fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). We do not merge upstream. We review upstream changes one at a time, on the real code diff, and record what we did with each one.

The agent-facing procedure lives in the [`upstream-sync` skill](../../.agents/skills/upstream-sync/SKILL.md). This page describes the machinery it drives.

## The ledger

`upstream/sync.json` is the record of everything decided since the fork point.

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `upstreamRemote` | Git remote that points at upstream.                                                |
| `upstreamBranch` | Branch we track on that remote.                                                    |
| `forkPoint`      | Upstream commit this fork branched from.                                           |
| `lastReviewed`   | Newest upstream commit that, together with every commit before it, has a decision. |
| `entries`        | One decision per upstream commit, in upstream history order.                       |

Each entry records `upstream` (the commit), `pr` (the pull request number, or `null` for a commit pushed without one), `title`, `decision`, `ours` (our commit that carries the change, or `null`), `reason`, and `reviewedAt`.

`decision` is one of:

- `adopted` — taken as-is, modulo the rebrand substitutions.
- `adapted` — the behavior came across, the implementation differs.
- `skipped` — deliberately not taken. The `reason` becomes precedent.
- `deferred` — wanted, not landed yet. Stays visible for a later pass.

The schema is an Effect Schema in [`scripts/lib/upstreamSync.ts`](../../scripts/lib/upstreamSync.ts). `node scripts/upstream-sync.ts validate` checks the file against it.

`lastReviewed` only ever advances across the leading run of commits that have entries. Deciding a later change before an earlier one is fine; it just does not move the marker past the undecided one.

## The report

```bash
node scripts/upstream-sync.ts report            # Markdown on stdout
node scripts/upstream-sync.ts report --out report.md
node scripts/upstream-sync.ts report --no-fetch  # skip the fetch
```

The report fetches the upstream remote, lists the first-parent commits in `lastReviewed..upstream/main`, and groups them by the `(#1234)` marker in the subject. Commits without one are their own change.

For each change it reports the files touched with our path mapping applied, the areas hit, the paths that land on surfaces we keep compatible or replaced, the files we already changed since the fork point, and the `git show` command to read the diff.

The report is an index, not a judgement. It says where a change lands, never whether it belongs here. There is deliberately no conflict prediction: the agent cherry-picks and resolves whatever git actually reports.

## The rebrand helper

[`scripts/lib/upstreamRebrandMap.ts`](../../scripts/lib/upstreamRebrandMap.ts) is the single source of truth for the fork's vocabulary: `@t3tools/*` to `@ras-code/*`, `T3CODE_*` to `RAS_CODE_*`, `T3 Code` to `RAS Code`, the mobile native module directories, and the rest. It also holds the do-not-rename list, which is matched first and copied through untouched.

```bash
node scripts/upstream-rebrand.ts <files>      # rewrite files in place
node scripts/upstream-rebrand.ts --patch      # rewrite a diff on stdin
```

The helper is assistive. It turns mechanical brand differences into a clean apply, and prints the brand tokens it could not decide so a human resolves them.

### Never renamed

Wire protocol names crossing the WebSocket, `/.well-known/t3/environment`, `refs/t3/checkpoints`, `app.t3.codes` and `clerk.t3.codes`, the product name "T3 Connect", the legacy theme ids `t3-chat` and `t3-chat-dark`, and links to `pingdotgg/t3code`.

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
- Never `git merge upstream/main`. The fork diverges on purpose.
