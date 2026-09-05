# Glossary

Terms whose meaning matters across RAS Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| RAS Code home  | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime RAS Code controls, such as Codex or Claude Code.                                           |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into RAS Code operations and events.                   |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Split chat panes

| Term                   | Meaning                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routed pane            | The pane holding the thread the URL names. There is exactly one, and it is the only pane a deep link can address.                                            |
| Companion pane         | The optional second pane. It holds a reference to a server thread, never a draft, because a promoted draft owns navigation.                                  |
| Focused pane           | The pane taking window shortcuts and the sidebar's active row. Deliberately not the routed pane: making the URL follow focus would swap panes under a click. |
| Collapse on navigation | Any change of routed thread closes the split, so clicking a thread means "go there, on its own". Promoting the companion is the exception.                   |

## Forked threads

| Term              | Meaning                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork              | A thread cut from a point in another thread's past. `thread.forked` carries everything a replay needs, and `forkedFrom` records the origin. |
| Inherited message | A message copied from a fork's parent, flagged `inherited`. It is context, not work the fork's provider did.                                |

## Provider fallback and quotas

| Term               | Meaning                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fallback provider  | The PostHog AI Gateway when it temporarily carries turns for an exhausted subscription provider, preserving the thread's logical provider and model. |
| Composite driver   | A driver that presents several upstream providers as one instance, as the gateway does.                                                              |
| Usage limits       | The rolling subscription quota windows a provider reports for its account. Each driver decides in `checkProvider` whether it has any.                |
| Usage limit source | A read-only quota feed outside this environment's provider CLIs, such as a CLIProxyAPI hub, configured under `settings.usageLimitSources`.           |

## Upstream sync

| Term          | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Ledger        | `upstream/sync.json`, one entry per upstream change with its decision and reasoning.                                            |
| Last reviewed | The ledger's high-water mark. It advances only across a leading run of decided changes.                                         |
| Decision      | What we did with an upstream change: adopted, adapted, reimplemented, skipped, obsolete, or deferred.                           |
| Rebrand map   | `scripts/lib/upstreamRebrandMap.ts`, the substitution table that rewrites upstream vocabulary into ours, and what it preserves. |
