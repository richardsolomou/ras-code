# Upstream Sync

RAS Code is a diverging fork of `pingdotgg/t3code`. We want the improvements people make there. We do not want their repository structure, their feature set, or their release cadence.

Those two goals pull apart over time, so the unit of work is **the change an upstream author made**, not the patch they wrote. A cherry-pick is a shortcut that works while a file still means the same thing in both trees. When it stops working, you port the behaviour instead — you do not force the patch, and you do not skip the improvement.

Every change gets exactly one decision, written to `upstream/sync.json` before `lastReviewed` moves.

Read [`docs/internals/upstream-sync.md`](../../../docs/internals/upstream-sync.md) for the ledger fields and the decision policy.

## Start with the report

```bash
node scripts/upstream-sync.ts report --out /tmp/upstream-report.md
```

It fetches the `t3code` remote, lists the first-parent commits in `lastReviewed..t3code/main`, groups them by pull request, maps every upstream path onto ours, and flags paths that land on surfaces we keep compatible, replaced, removed, or redesigned. Pass `--no-fetch` when the remote is already current.

The remote is named `t3code`, not `upstream`, because RAS Code treats a remote named `upstream` as the canonical repository identity. In an existing checkout, verify that `upstream` points to `pingdotgg/t3code`, then rename it:

```bash
git remote get-url upstream
git remote rename upstream t3code
```

In a fresh checkout, add it before running the report:

```bash
git remote add t3code git@github.com:pingdotgg/t3code.git
```

The report is an index, not a judgement. It tells you where to look. The decision comes from the diff.

## Decide each change on the real diff

For every change in the report, in upstream history order:

1. Read the actual diff: `git show <sha>`. The report's file table tells you where to look; it does not tell you what the change does.
2. Say what it does in one sentence, in our vocabulary. That sentence is the change's **intent**, and it is the thing worth keeping — a diff stops applying long before the intent stops mattering.
3. Weigh the intent against [`apps/web/PRODUCT.md`](../../../apps/web/PRODUCT.md), [`AGENTS.md`](../../../AGENTS.md), and [`apps/web/DESIGN.md`](../../../apps/web/DESIGN.md).
4. Read the precedent in `upstream/sync.json`. Similar changes get similar decisions, and the `reason` field is where that precedent lives.

Standing precedent:

- Skip marketing, legal, and branding changes. We replaced those surfaces.
- Keep the wire protocol compatible. Adopt contract changes, and never rename the identifiers on the do-not-rename list below.
- Adopt a better structure rather than defending ours. When upstream's design is the better one, converge on it and re-express what is ours on top; do not preserve our version merely because it is ours.
- Defer, do not skip, a change we want but cannot land now. `deferred` keeps it visible; `skipped` closes it.

## Pick a track

**Fast track — cherry-pick.** Use it while the file still maps one-to-one and the conflict is mechanical: our longer brand name rewrapping a line, a renamed identifier, a test-fixture prefix. Most changes are still this today.

**Slow track — port the intent.** Use it when the patch cannot land honestly: the file moved, the feature is gone, the surrounding code was redesigned, or resolving the conflict would quietly revert something of ours. Write the behaviour ourselves, in our shape, and record the decision as `reimplemented` with the upstream sha. A `reimplemented` entry means we have the improvement, not that we copied the code.

Choosing the slow track is not a failure. Forcing a patch into a shape it no longer fits is.

## Adopt, adapt, or reimplement

Work on a branch off `main`, one commit per upstream change.

```bash
git cherry-pick -x <sha>
node scripts/upstream-rebrand.ts <files git left conflicted>
# resolve whatever is left by hand
node scripts/upstream-sync.ts verify
node_modules/.bin/vp test run <test files for what you touched>
git add <explicit paths>
git cherry-pick --continue
```

`upstream-rebrand.ts` applies the substitution table in `scripts/lib/upstreamRebrandMap.ts`. Run it first on every conflicted file: most upstream conflicts are only the rebrand. What is left after that is a real conflict, and you resolve it by hand. The helper also prints the brand tokens it could not decide; check those.

Never run the rebrand helper on `scripts/lib/upstreamRebrandMap.ts` or its test. Their fixtures name upstream on purpose, and rewriting them breaks the map. `verify` exempts them; a bare `grep | xargs` does not.

To preview a change before committing anything:

```bash
git diff --no-renames --binary <sha>^ <sha> | node scripts/upstream-rebrand.ts --patch | git apply --3way
```

Then record the decision:

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision adapted \
  --ours "$(git rev-parse HEAD)" --reason "Ported the fix; kept our toast styling."
```

Record an `intent` whenever the code did not come across verbatim:

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision deferred \
  --intent "Composer keeps its glass surface and rounded shadow while the thread list scrolls under it." \
  --reason "Depends on the Uniwind token set we have not adopted yet."
```

## Verify before you continue

A cherry-pick that reports no conflict still breaks the tree in ways git cannot see. All of these happened in a single sync:

- Upstream package scopes (`@t3tools/...`) survived in files that never conflicted, so the tree stopped compiling — but only under a full typecheck, several changes later.
- An upstream directory (`oxlint-plugin-t3code/`) arrived as a new path, because adding a path is not a conflict.
- A delete/modify conflict resolved to _keeping_ files upstream had deleted.
- A rename landed in the tests but not the implementation, surfacing as a type error three changes later.

So after each pick, before moving on:

```bash
node scripts/upstream-sync.ts verify        # upstream scopes and paths
vp run --filter <package> typecheck          # the tree still compiles
vp test run <files for what you touched>
```

Run the typecheck for every package the change touched, not just the one whose tests you ran. Most of these failures are invisible to a per-file test.

## Skip, defer, or mark obsolete

```bash
node scripts/upstream-sync.ts mark --upstream <sha> --decision skipped \
  --reason "Touches apps/marketing, which we replaced."
```

- `skipped` — we decided against it. Closed.
- `obsolete` — the surface no longer exists here, so there is nothing to decide. A fact, not a judgement.
- `deferred` — we want it and cannot land it yet. Always give it an `--intent`, or it is unactionable later.

`mark` advances `lastReviewed` only across the leading run of commits that now have entries, so deciding a later change out of order never buries an earlier one.

## Keep the surface map honest

`scripts/lib/upstreamSync.ts` declares which upstream paths land on surfaces we replaced, removed, or redesigned, so the report can say "there is nothing to land here" instead of producing a conflict. As we move and delete code, add entries.

One rule: **a surface we are migrating toward is not a divergence.** `divergedPrefixes` is for designs we have decided to keep different, permanently. Somewhere we are merely behind upstream, or mid-migration onto their design, is a deferred change with an intent. Listing it as diverged turns off cherry-picking for that whole subtree and quietly commits us to maintaining a fork of it forever.

## Batching

Independent changes can fan out to subagents, one worktree each. Follow the repository's worktree rules: worktree state lives in that worktree's gitignored `.ras-code`, `vp i` runs there, and subagents do not start dev servers. Merge the results back onto the branch in upstream history order so the ledger stays ordered, and let one agent run `mark` per change.

Do not batch with a shell loop that assumes word splitting. `zsh` does not split unquoted variables, so `git add $files` silently adds nothing while the loop reports success — which writes ledger entries for changes that never landed. Use a bash script with arrays, and check `git log` against the ledger afterwards.

## Do not rename

These keep their upstream spelling wherever they appear:

- Wire protocol names crossing the WebSocket.
- `/.well-known/t3/environment`
- `refs/t3/checkpoints`
- Theme ids `t3-chat` and `t3-chat-dark`
- Links to `pingdotgg/t3code`

## Never

- Never run `git merge t3code/main` or `git rebase` onto `t3code`. The fork diverges on purpose; changes come across one at a time.
- Never advance `lastReviewed` past a change that has no ledger entry, and never edit `lastReviewed` by hand.
- Never touch the do-not-rename identifiers, in code or in a rebranded patch.
- Never hand-merge a lockfile. Take ours and regenerate it against the new manifests: upstream's integrity hashes contain `t3` substrings that the rebrand map will happily corrupt.
- Never treat the report as a decision. A short file list does not mean the change belongs here.
- Never commit the generated report. Write it to a path outside the worktree.
