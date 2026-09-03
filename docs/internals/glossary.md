# Glossary

> For maintainers. Using RAS Code? See [docs/user](../user/).

This is a living glossary for RAS Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Chat panes](#chat-panes)
- [Upstream sync](#upstream-sync)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

#### Fork

A thread cut from a point in another thread's past. `thread.fork` is a server-dispatched command (clients ask through a `thread.turn.start` bootstrap; [ws.ts][29] resolves the inherited prefix) and produces one `thread.forked` event carrying everything a replay needs. The fork records its origin in `forkedFrom` on both the thread and its shell. See [decider.ts][8], [projector.ts][4], and [forking-threads.md][30].

#### Inherited message

A message copied from a fork's parent, flagged `inherited` in [the contracts][1]. It carries no turn id, is never revertable, and survives every revert in the fork — it is the parent's history, not work this thread did. Attachments are not copied.

#### Resume anchor

A provider-opaque token identifying a completed turn inside the provider's own conversation, emitted on `turn.completed` and stamped onto the turn projection. Only the adapter that wrote it can read it. A fork uses it to ask the provider to branch at exactly that point; providers with no such addressing leave it absent and their forks fall back to a transcript handoff ([forkTranscript.ts][31]). See [ProviderRuntimeIngestion.ts][5] and [ProviderCommandReactor.ts][12].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Seven drivers ship built in: Codex, Claude, Cursor, Grok, OpenCode, PostHog AI Gateway, and Antigravity. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Composite driver

A driver that runs other drivers rather than a harness of its own. `posthogGateway` is the only one: it creates a Claude child and a Codex child in its own scope, serves the gateway's whole catalog, and routes each model to the child whose request shape the gateway will accept for it. It rewrites its children's sessions and runtime events onto its own instance id and driver kind, and adopts the Claude child's continuation key so a plain Claude instance can hand it a started thread. See [PostHogGatewayDriver.ts][25] and the [provider architecture][16].

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

#### Fallback provider

The PostHog AI Gateway when it temporarily carries turns for an exhausted subscription provider.
RAS Code discovers it automatically, preserves the thread's logical provider and model, and tries
the subscription again after its limit resets. See the [provider architecture][16] usage limits
section.

#### Model manifest

The per-driver list of current model slugs that decides which models land in the model picker's legacy section. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Chat panes

Client-side vocabulary for the split chat inset. The model is a pure module, [chatPaneStore.ts][32]; [ChatPanes.tsx][33] renders it.

#### Routed pane

The pane holding the thread the URL names — the router's outlet. There is always exactly one, and it is the only pane a deep link can address.

#### Companion pane

The optional second pane beside the routed one. It holds a `ScopedThreadRef` to a server thread, never a draft, because a draft owns navigation when it is promoted. It is gated on the same render state as the routed thread route: ChatView returns an empty state before some of its hooks when it has no thread, so mounting it against a thread that has not loaded crashes on the render that fills in.

#### Focused pane

The pane the user is working in: it takes the window-level shortcuts and the sidebar's active row. Deliberately distinct from the routed pane, because making the URL follow focus would swap the two panes' DOM nodes out from under a click. Focus is client state; the URL only moves when the user chooses **Make primary**.

#### Collapse on navigation

The rule that any change of routed thread closes the split, so clicking a thread means "go there, on its own" rather than re-targeting one of two panes. Promoting the companion is the exception, and [chatPaneStore.ts][32] recognises it without a flag: it is the navigation whose previous routed thread is the companion.

#### Suspended split

What a window too narrow for two readable panes shows. The companion is kept in the store and hidden rather than dropped, so widening restores it.

### Upstream sync

RAS Code is a diverging fork of `pingdotgg/t3code`. Upstream changes come across one at a time, never by merge. The workflow is described in [upstream-sync.md][26].

#### Ledger

`upstream/sync.json`, the record of what we did with every upstream change since the fork point. Its schema lives in [upstreamSync.ts][27].

#### Fork point

The upstream commit this fork branched from. Everything in the ledger is measured from it.

#### Last reviewed

The newest upstream commit that, together with every commit before it, has a ledger entry. It never advances past an undecided change.

#### Decision

What we did with one upstream change: `adopted`, `adapted`, `skipped`, or `deferred`.

#### Rebrand map

The single source of truth for this fork's vocabulary and its do-not-rename list, in [upstreamRebrandMap.ts][28].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]
- [Upstream sync][26]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/provider/Drivers/PostHogGatewayDriver.ts
[26]: ./upstream-sync.md
[27]: ../../scripts/lib/upstreamSync.ts
[28]: ../../scripts/lib/upstreamRebrandMap.ts
[29]: ../../apps/server/src/ws.ts
[30]: ../user/forking-threads.md
[31]: ../../apps/server/src/orchestration/forkTranscript.ts
[32]: ../../apps/web/src/chatPaneStore.ts
[33]: ../../apps/web/src/components/chat/ChatPanes.tsx
