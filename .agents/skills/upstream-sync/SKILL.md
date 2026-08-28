---
name: upstream-sync
description: Track what changed in pingdotgg/t3code since RAS Code last reviewed it, and bring changes across one at a time as adopt, adapt, or skip. Use when an agent needs to review upstream commits, port an upstream fix or feature into this fork, decide whether an upstream change belongs here, resolve rebrand conflicts in a cherry-picked upstream diff, or record a decision in the upstream sync ledger.
---

# Upstream Sync

RAS Code is a diverging fork of `pingdotgg/t3code`. The unit of work is the real code diff of one upstream change, not a changelog line. Every change gets exactly one decision — adopted, adapted, skipped, or deferred — and that decision is written to `upstream/sync.json` before `lastReviewed` moves.

Read [`docs/internals/upstream-sync.md`](../../../docs/internals/upstream-sync.md) for the ledger fields and the decision policy.

## Start with the report

```bash
node scripts/upstream-sync.ts report --out /tmp/upstream-report.md
```

It fetches the upstream remote, lists the first-parent commits in `lastReviewed..upstream/main`, groups them by pull request, maps every upstream path onto ours, and flags the paths that land on surfaces we keep compatible or already replaced. Pass `--no-fetch` when the remote is already current.

The report is an index, not a judgement. It tells you where to look. The decision comes from the diff.

## Decide each change on the real diff

For every change in the report, in upstream history order:

1. Read the actual diff: `git show <sha>`. The report's file table tells you where to look; it does not tell you what the change does.
2. Weigh it against [`apps/web/PRODUCT.md`](../../../apps/web/PRODUCT.md), [`AGENTS.md`](../../../AGENTS.md), and [`apps/web/DESIGN.md`](../../../apps/web/DESIGN.md).
3. Read the precedent in `upstream/sync.json`. Similar changes get similar decisions, and the `reason` field is where that precedent lives.

Standing precedent:

- Skip marketing, legal, and branding changes. We replaced those surfaces.
- Keep the wire protocol compatible. Adopt contract changes, and never rename the identifiers on the do-not-rename list below.
- Adapt UI changes into our console grammar rather than copying upstream styling verbatim.
- Defer, do not skip, a change that we want but cannot land now. `deferred` keeps it visible; `skipped` closes it.

## Adopt or adapt

Work on `main`, one commit per upstream change.

```bash
git cherry-pick -x <sha>
node scripts/upstream-rebrand.ts <files git left conflicted>
# resolve whatever is left by hand
node_modules/.bin/vp test run <test files for what you touched>
git add <explicit paths>
git cherry-pick --continue
```

`upstream-rebrand.ts` applies the substitution table in `scripts/lib/upstreamRebrandMap.ts`. Run it first on every conflicted file: most upstream conflicts are only the rebrand. What is left after that is a real conflict, and you resolve it by hand. The helper also prints the brand tokens it could not decide; check those.

To preview a change before committing anything:

```bash
git diff --no-renames --binary <sha>^ <sha> | node scripts/upstream-rebrand.ts --patch | git apply --3way
```

Then record the decision:

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision adapted \
  --ours "$(git rev-parse HEAD)" --reason "Ported the fix; kept our toast styling."
```

## Skip or defer

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision skipped \
  --reason "Touches apps/marketing, which we replaced."
```

`mark` advances `lastReviewed` only across the leading run of commits that now have entries, so deciding a later change out of order never buries an earlier one.

## Batching

Independent changes can fan out to subagents, one worktree each. Follow the repository's worktree rules: worktree state lives in that worktree's gitignored `.ras-code`, `vp i` runs there, and subagents do not start dev servers. Merge the results back onto `main` in upstream history order so the ledger stays ordered, and let one agent run `mark` per change.

## Do not rename

These keep their upstream spelling wherever they appear:

- Wire protocol names crossing the WebSocket.
- `/.well-known/t3/environment`
- `refs/t3/checkpoints`
- `app.t3.codes`, `clerk.t3.codes`
- "T3 Connect"
- Theme ids `t3-chat` and `t3-chat-dark`
- Links to `pingdotgg/t3code`

## Never

- Never run `git merge upstream/main` or `git rebase` onto upstream. The fork diverges on purpose; changes come across one at a time.
- Never advance `lastReviewed` past a change that has no ledger entry, and never edit `lastReviewed` by hand.
- Never touch the do-not-rename identifiers, in code or in a rebranded patch.
- Never treat the report as a decision. A short file list does not mean the change belongs here.
- Never commit the generated report. Write it to a path outside the worktree.
