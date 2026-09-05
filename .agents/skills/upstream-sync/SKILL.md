# Upstream Sync

RAS Code is a diverging fork of `pingdotgg/t3code`. We want the improvements people make there. We do not want their repository structure, their feature set, or their release cadence.

Those two goals pull apart over time, so the unit of work is **the change an upstream author made**, not the patch they wrote. A cherry-pick is a shortcut that works while a file still means the same thing in both trees. When it stops working, you port the behaviour instead — you do not force the patch, and you do not skip the improvement.

Every change gets exactly one decision, written to `upstream/sync.json` before `lastReviewed` moves.

Read [`docs/internals/upstream-sync.md`](../../../docs/internals/upstream-sync.md) for the ledger fields and the decision policy.

## Auto-adopt the aligned prefix first

```bash
node scripts/upstream-sync.ts adopt-aligned
```

This fetches upstream and adopts the leading run of commits whose normalized three-way merges do not overlap a fork edit. It rewrites paths and product vocabulary before merging, formats the result, runs `verify` after every commit, records the ledger entries, and stops before the first real divergence. `normal` and `wire` paths are upstream-owned by policy, so these commits do not need an agent to reread their diffs. Use `--dry-run` to inspect the next commit without writing.

Run it again after resolving each reviewed divergence. The goal is for the agent to spend tokens only on overlapping product decisions, not clean upstream work.

## Report what still needs judgement

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

The report is an index for the first change `adopt-aligned` could not settle. It tells you where to look. The decision comes from the diff.

It ends with the brand tokens the rebrand table cannot decide across the whole range, most frequent first. Extend `scripts/lib/upstreamRebrandMap.ts` for those **before picking anything**. Left alone they arrive one at a time, mid-pick, and each one costs a detour: the last round hand-renamed `t3-citation`, `t3-file-icon-video` and `t3-upload-uuid` separately, and spent seven commits teaching the map afterwards.

## Decide each change on the real diff

For every change in the report, in upstream history order:

1. Read the actual diff: `git show <sha>`. The report's file table tells you where to look; it does not tell you what the change does.
2. Say what it does in one sentence, in our vocabulary. That sentence is the change's **intent**, and it is the thing worth keeping — a diff stops applying long before the intent stops mattering.
3. Weigh the intent against [`apps/web/PRODUCT.md`](../../../apps/web/PRODUCT.md), [`AGENTS.md`](../../../AGENTS.md), and [`apps/web/DESIGN.md`](../../../apps/web/DESIGN.md).
4. Read the precedent in `upstream/sync.json`. Similar changes get similar decisions, and the `reason` field is where that precedent lives.

Standing precedent:

- Skip marketing, legal, and branding changes. We replaced those surfaces.
- Keep the wire protocol compatible. Adopt contract changes, and never rename the identifiers on the do-not-rename list below.
- Converge by default. Take upstream's structure and re-express what is ours on top, and say why in the ledger when you do not. This is the precedent the round through `06336460c` broke 42 times against 9; see [Two costs, measured differently](#two-costs-measured-differently).
- Defer, do not skip, a change we want but cannot land now. `deferred` keeps it visible; `skipped` closes it.

## Merge main first, and keep the round small

Start by merging `origin/main` into the sync branch, and merge it again before opening the pull request. A sync that runs long enough for `main` to move pays for it twice: once in conflicts, and once in decisions that contradict each other. The last round adopted upstream's manifest-driven Claude catalog while `main` was reverting the fork's live-model merge underneath it, and reconciling the two cost more than any single pick.

The same reasoning bounds the round: a day of upstream is a batch worth doing, a week is a merge conflict with a ledger attached.

One exception, and it is the dangerous one. When the round is stacked on a previous sync branch and that branch was **squash-merged**, do not merge `origin/main`. Squashing rewrites the parent's commits into one, so the merge base falls back to before them and both sides look like they added the same code. Git then merges cleanly and duplicates it: the last round came back with a redeclared `findRemoteTrackingRemote` and three duplicate function implementations in `UsageLimits.tsx`, none of them a conflict. Replay this round's own commits instead:

```bash
git rebase --onto origin/main <tip of the squashed parent branch> <this branch>
```

`gh pr view <parent> --json headRefOid` gives the tip after the remote branch is deleted.

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
git add <explicit paths>
git cherry-pick --continue
```

Run the tests for a change you had to think about — anything you adapted or reimplemented, where you rewrote behaviour and want to know it still holds. A clean pick does not earn a test run of its own; `gate` covers it.

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
- Effect service keys arrived still namespaced under `t3/`, which only the owning package's typecheck reports.

So after each pick, before moving on:

```bash
node scripts/upstream-sync.ts verify
```

`verify` runs in under a second, so it stays per pick. It reports upstream scopes, upstream identifier namespaces, upstream paths, and any package a **fork-only** file imports that no manifest declares any more — upstream prunes dependencies against upstream's tree, so a removal that is correct there can still be wrong here.

Typecheck and tests do **not** belong per pick. Half of a round is clean cherry-picks: last round 63 of 125 entries read `"Clean cherry-pick."` verbatim. A per-package typecheck is ~8s and a test pass is more, so running both after each of those costs far more than it ever catches, and catches nothing that surviving to `gate` would miss.

For a run of changes you have already read and judged as adopt:

```bash
node scripts/upstream-sync.ts batch --sha <a> --sha <b> --sha <c>
```

It rewrites paths and vocabulary before applying each change. When a patch does not apply directly, it performs a three-way merge against rebranded upstream snapshots and retries with formatting only when necessary. If `mergiraf` is installed, `batch` also resolves independent syntax-level edits inside the same textual hunk. It runs `verify` after each commit and stops when behavior really overlaps. Judgement is still yours for commits that reached this path; batching removes the mechanical resolution work.

## Gate once, before you push

```bash
node scripts/upstream-sync.ts gate          # add --quick to skip release:smoke and the full test run
```

`gate` runs what CI runs, in the order that fails cheapest first. Reinstalling from the lockfile comes first and is the whole point: everything after it is a lie without it. A stale `node_modules` still resolves a dependency the picks removed, so the tree typechecks locally and fails on a fresh checkout. That is exactly how `@effect/platform-node-shared` reached CI last round, along with a SwiftLint violation no local loop ran and a patch orphaned by a version bump that only a from-scratch lockfile regeneration shows.

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

## Two costs, measured differently

A divergence costs us twice, and the two are measured differently. **Conflicts** announce themselves and get decided. **Drift** is silent: upstream moves on, the merge succeeds, and we keep an approach upstream abandoned. Counting conflicts finds the cheap failures and misses the expensive ones — every defect these syncs have documented arrived through a clean merge, not a conflict. #8584 silently reinstated a prop we had removed, with its only conflict 330 lines away. A handler extraction turned an upstream move into resurrected code that did not parse, with no conflict marker at all.

### Measuring conflicts

Two proxies look reasonable and are not:

- **Upstream touches per file.** Upstream edits `ChatView.tsx` more than any other file in a pending range and never conflicts there, because our divergence in it is additive. Touches are not conflicts.
- **Fork delta since the fork point.** That number includes every upstream change we already picked, and counts branding as fork work. Diff against upstream at `lastReviewed`, rebranded first.

What holds is a replay: cherry-pick each pending change onto `main` with `--no-commit`, count the conflict hunks, attribute them, abort. Use changes near the reviewed boundary; one 300 ahead conflicts on the upstream drift in between. Run this in a separate worktree — a replay loop and ordinary work in the same worktree will corrupt each other, and a stray `reset --hard` in the loop can move the branch you are standing on.

### Measuring drift

Drift accumulates one pick at a time, and the ledger records it. Through `06336460c`: of 121 `adapted` entries, **42 gave a reason that explicitly preserved a fork design and 9 converged onto upstream**. Each of those 42 was defensible alone. Together they are the fork drifting onto designs upstream has left behind, and they run against the standing precedent above.

So the default at pick time is **converge**: take upstream's structure and re-express what is ours on top, and record a reason in the ledger when you do not. Preserving our version because it is ours is the thing that compounds.

### Do not switch to upstream's head instead

Replacing the fork with upstream's current tree and re-applying our features looks like it would clear the backlog and the drift together. Measured through `06336460c`, with both the merge base and upstream's head rebranded so branding cancels out, that merge conflicts in **478 files, 1,549 hunks, 154,720 lines**. The same range picked incrementally is about **22,500** conflict lines.

The 7x gap is upstream's own churn. Commit by commit their refactors apply cleanly in sequence; collapsed into one diff, `A -> C` collides with everything we changed in `A`. The one-shot also throws away the per-change diff and message that make each conflict decidable, and strands every `ours` sha in the ledger.

The decisions are the same either way. Picking incrementally just costs less and gives better information per decision.

## Batching

Sequential batching on one branch is `batch`, above. Fan-out is for when the round is genuinely large and the changes are independent: one worktree each. Follow the repository's worktree rules: worktree state lives in that worktree's gitignored `.ras-code`, `vp i` runs there, and subagents do not start dev servers. Merge the results back onto the branch in upstream history order so the ledger stays ordered, and let one agent run `mark` per change.

Do not batch with a shell loop that assumes word splitting. `zsh` does not split unquoted variables, so `git add $files` silently adds nothing while the loop reports success — which writes ledger entries for changes that never landed. Use a bash script with arrays, and check `git log` against the ledger afterwards.

## What we rebrand, and what we do not

Rebranding is not free: every rewritten line is a line upstream can edit and we cannot apply cleanly, and a new upstream file that imports our spelling does not compile until something rewrites it. So the map covers what a user can see and stops there.

**Ours, and rebranded:** the product name in prose and UI, `RAS_CODE_*` environment variables, `~/.ras-code` and `.ras-code` on disk, `ras.json`, the `ras`/`ras-code` CLI commands, theme ids, the session cookie, CSS custom properties and font classes (they show in devtools), Effect service keys (they show in traces), Android package names (they show in app metadata), and the MCP tool names our own server exposes.

**Upstream's, and left alone:** the `@t3tools/` workspace scope. Every package under it is private, so it never reaches a user, and keeping upstream's spelling keeps roughly 3,000 import lines identical to theirs.

Reverting the remaining internal identifiers was measured and rejected. `RasCode`-style symbols, `ras_code_` snake identifiers and `ras-code-` kebab tokens are ~485 names, and "an upstream counterpart exists" is not enough to decide them: `t3_thread_send` exists upstream, but our `ras_code_thread_send` is a lookup key for the tool name _our_ MCP server exposes, and renaming it back reintroduces the label bug the sync through `70cd258d8` fixed. Hand review found that check wrong on about a third of the identifiers where the name carries meaning. The rest are test temp-dir prefixes, which are opaque strings the map already resolves in one line.

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
- Never assume a release tag name is free. The `t3code` remote brings hundreds of upstream tags into the clone, so `git tag vX.Y.Z` fails with "already exists" and a separate `git push origin vX.Y.Z` then ships _upstream's_ tag, pointing at an upstream commit. Tag with `-f`, confirm `git rev-list -n1 <tag>` equals `origin/main`, and only then push.
