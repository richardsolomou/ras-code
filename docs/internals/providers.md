# Provider architecture

> For maintainers. Using RAS Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. RAS Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with six entries:

| Driver kind      | Driver source                                |
| ---------------- | -------------------------------------------- |
| `codex`          | [`Drivers/CodexDriver.ts`][codex]            |
| `claudeAgent`    | [`Drivers/ClaudeDriver.ts`][claude]          |
| `cursor`         | [`Drivers/CursorDriver.ts`][cursor]          |
| `grok`           | [`Drivers/GrokDriver.ts`][grok]              |
| `opencode`       | [`Drivers/OpenCodeDriver.ts`][opencode]      |
| `posthogGateway` | [`Drivers/PostHogGatewayDriver.ts`][posthog] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

### The composite driver

`posthogGateway` is the one driver that is not a harness of its own. The PostHog AI Gateway serves
its whole catalog from one origin but on two request shapes — `claude-*` ids only on Anthropic
Messages, everything else only on Responses (`@ras-code/shared/posthogGateway`) — and no shipped
harness speaks both. `PostHogGatewayDriver.create` therefore calls `ClaudeDriver.create` and
`CodexDriver.create` in its own scope and composes the two children:

- **Snapshot.** The models come from the gateway's own catalog (`fetchGatewayModels`, refreshed
  every five minutes with the last good list kept), each model taking its capabilities from the
  child that will serve it. Status is "ready" when the child needed for at least one catalog model
  is ready, so a missing Codex install does not hide the Claude half of the catalog. The usage limit
  is the worse of the two children's.
- **Adapter.** Every call routes on `gatewayModelShape(model)`. A thread's shape is recorded at
  `startSession`; a `sendTurn` that asks for a model on the other shape is refused, because the two
  harnesses hold no shared resume state. Sessions and runtime events are rewritten to carry the
  composite's instance id and driver kind — `ProviderService.correlateRuntimeEventWithInstance`
  rejects an event whose driver kind is not the one the registry bound to that instance, so passing
  a child's kind through would be a defect.
- **Continuation.** The composite adopts the Claude child's continuation key
  (`claude:home:<resolved home>`), which is what lets a plain Claude instance hand a started thread
  to it. Continuation key, not driver kind, is the compatibility test everywhere it matters:
  `ProviderCommandReactor.ensureSessionForThread` and `resolveFallbackSelection` both compare keys.

The children are internal. Their instance ids (`<id>_claude`, `<id>_codex`) never reach settings,
the registry, or the wire.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Usage limits and gateway fallback

The PostHog AI Gateway is the only usage fallback. Once a gateway instance is enabled, subscription
providers discover it automatically. There is no fallback setting or provider graph.

Quota state is derived from the `account.rate-limits.updated` runtime event, which both the Claude
and Codex adapters forward with their native payload. `providerUsageLimit.ts` normalises those two
shapes into one `ProviderUsageLimit` (`status`, `resetsAt`, `kind`, `utilization`), and
`ProviderRegistry` holds the result in memory keyed by instance id, projecting it onto
`ServerProvider.usageLimit` so clients see it on the provider snapshot. The state is deliberately
volatile: it is never written to the provider status cache, and an exhausted window reads back as
`ok` once `resetsAt` has passed. A turn that fails with a usage-limit message also marks its
instance exhausted, reading the reset instant out of the message when it names one and falling back
to a 30-minute cooldown when it does not.

`ProviderCommandReactor` owns the routing. It offers the gateway only when the subscription is
exhausted, the gateway advertises the exact requested model, and the gateway is available and not
exhausted. Instances that share a continuation key move the thread's provider conversation intact —
the composite adopts Claude's continuation identity, so started Claude threads resume. Every other
shape crosses as a fresh session with the recent transcript carried into the first prompt, which is
what `restartsSession` on the `provider.fallback.offered` payload tells the clients to warn about.

The user confirms the switch once for an exhaustion episode. The saved thread selection remains
the subscription provider and model while the provider session records the gateway that actually
runs the turn. This keeps thread identity stable and lets the next turn try the subscription again
after its reset. When the two harnesses cannot share continuation state, both the crossing and the
return start a fresh session and carry the recent thread transcript into its first prompt. A
successful primary turn emits `provider.fallback.returned`; another usage-limit failure before
output resumes the already-approved gateway without another prompt. The approved route is in
memory, so the handoff is also derived from durable state: a thread whose bound session sits on a
gateway instance other than its own selection is parked on a fallback, and its next turn carries
the transcript even when a restart forgot the crossing. The gateway never falls back to
itself, no alternative model is selected, and no fallback chain is traversed.

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and
text-generation helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent
borrowers share startup. The server closes 30 seconds after the last borrower releases it, or
when the provider instance closes. A failed or exited process can be started again on the next
use. An externally configured OpenCode server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password,
the client uses the password from the environment that the process inherits. External servers use
only their explicit provider password and never inherit the host's local password.

Every server connection must pass the authenticated `/global/health` check before inventory or
session operations start. The response must contain a valid version at or above 1.14.19. Local
owners cache this result for the lifetime of the spawned process. External actions check once when
they create their server connection, not for each model or SDK request.

Chat adapters keep their own server per thread. They register a thread-specific `t3-code` MCP
connection, while OpenCode stores MCP connections by directory. Sharing these chat servers
without changing MCP routing would let two threads in one directory replace each other's
connection.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

T3 Code does not own an external OpenCode process. Native configuration changes there can require
an external reload or restart before T3 Code's next refresh sees them.

The shared server's idle shutdown does not clear the catalog. Failed discovery keeps the last
known models, slash commands, and skills through the registry's existing merge rules. A successful
empty inventory is authoritative. Existing threads keep their explicit model identifier and
options when catalog metadata is missing; the catalog is not permission to choose a different
model for a thread.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Attachment access

The server stores uploaded attachments in its attachment directory, outside the project workspace.
`ProviderService` adds the absolute path of each attachment to the turn text, then passes every
attachment to the provider adapter. Each adapter decides what its provider ingests natively:

- Codex, Claude, Cursor, and Grok send images as native image inputs and skip generic files. For
  these providers, generic files reach the agent only as file paths in the turn text.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.

Claude receives the attachment directory as an allowed additional directory. Codex keeps its
configured sandbox policy, so access depends on that policy and the selected runtime mode. OpenCode
allows all paths in full-access mode and requests approval for directories outside the workspace in
restricted modes. Cursor and Grok use their own provider permission rules.

The server does not copy attachments into a project or bypass provider approval rules. If an agent
cannot read an attachment, the user must approve the access or select a runtime mode that permits it.

Updated attachment schemas tolerate unknown attachment members, but old image-only clients still
cannot decode messages that contain file attachments. Client file-picking rollouts must account for
this limit.

Do not run an old image-only server against state that contains file attachments. Replay decodes
each persisted event before projection. A file-bearing event can make `ProjectionPipeline` bootstrap
and `OrchestrationEngine` startup fail for the entire environment, not only the affected thread.

## RAS Code instructions in the system prompt

`SharedProviderInstructions.ts` holds the guidance RAS Code adds to an agent's prompt regardless of
provider. Today that is one section: where to write an image so the reader can see it. A client
often runs on a different machine than the environment, and the asset layer only serves markdown
images that resolve inside the project directory, so an agent that writes a screenshot to `/tmp`
produces a placeholder the reader cannot act on.

Only two adapters have a channel for it:

- **Codex** appends it in `buildCodexDeveloperInstructions`, outside the mode blocks, so plan and
  default turns both carry it.
- **Claude** passes it as `systemPrompt.append` alongside the `claude_code` preset.
- **Cursor and Grok** get nothing. ACP `session/new` accepts a cwd and MCP servers, with no field
  for instructions.
- **OpenCode** gets nothing. Its prompt call takes text and file parts only.

Nothing here may be load-bearing for correctness, since three of the five providers never see it.
It reduces a common mistake; the failure itself has to stay legible on its own, which is why an
image that cannot be served names its reason in the chat placeholder rather than failing silently.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Forking a provider conversation

A [fork](./glossary.md#fork) needs the provider to continue a conversation from a point in its
past, and drivers differ in whether they can. Each adapter answers by whether it emits a
[resume anchor](./glossary.md#resume-anchor) on `turn.completed` and whether it understands
`forkAtAnchor` in a resume cursor.

- **Claude** does both. `ClaudeAdapter` reports the last assistant message uuid as the anchor, and a
  cursor carrying `forkAtAnchor` starts the session with `resume` + `resumeSessionAt` +
  `forkSession`, so the fork replays the parent up to that message into a session id RAS Code mints.
  The parent's session is never touched.
- **Codex, Cursor, Grok, and OpenCode** emit no anchor. ACP's `session/fork` forks a whole session
  with no fork point and is unstable, and `thread/rollback` mutates the session it is called on —
  neither is a branch.

`ProviderCommandReactor` decides per fork, from persisted state only, so it answers the same way
across a restart: it needs the parent's persisted resume cursor, a matching continuation key (the
same compatibility test a mid-thread instance switch uses), and an anchor on the parent turn at the
fork point. When any of those is missing — including every cross-provider fork — the fork's first
turn is prefixed with a rendered transcript of the inherited prefix instead
([`forkTranscript.ts`][forktranscript]). The workspace carries the real state either way: the fork
point's checkpoint is restored into the fork's worktree.

An adapter that gains a fork primitive only has to emit an anchor and read `forkAtAnchor`; nothing
above it changes.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[posthog]: ../../apps/server/src/provider/Drivers/PostHogGatewayDriver.ts
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[forktranscript]: ../../apps/server/src/orchestration/forkTranscript.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
