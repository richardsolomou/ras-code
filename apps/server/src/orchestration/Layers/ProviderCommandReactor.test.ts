// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  type ProviderUsageLimit,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const assistantQuoteText = "Retain the reconnect backoff.";
const assistantCitation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("source-environment"),
  threadId: ThreadId.make("source-thread"),
  messageId: asMessageId("source-message"),
  text: assistantQuoteText,
  start: 0,
  end: assistantQuoteText.length,
  prefix: "",
  suffix: "",
};

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  const driverKindForInstanceId = (instanceId: ProviderInstanceId): ProviderDriverKind => {
    const raw = String(instanceId);
    return ProviderDriverKind.make(
      raw.startsWith("claude")
        ? "claudeAgent"
        : raw.startsWith("codex")
          ? "codex"
          : raw.startsWith("posthog")
            ? "posthogGateway"
            : raw.startsWith("antigravity")
              ? "antigravity"
              : raw,
    );
  };

  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly serverActivation?: Effect.Effect<void>;
    readonly interruptTurnEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly stopSessionEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
    readonly providerInstances?: Record<string, unknown>;
    readonly usageLimits?: Map<ProviderInstanceId, ProviderUsageLimit>;
    readonly extraProviderSnapshots?: ReadonlyArray<Record<string, unknown>>;
    readonly primaryProviderSnapshot?: Record<string, unknown>;
    /** Continuation keys for instances of one driver that do not share a home. */
    readonly continuationKeys?: Record<string, string>;
    readonly tryHandlePromptCommandEffect?: ProviderAuthService["Service"]["tryHandlePromptCommand"];
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ras-code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const tryHandlePromptCommand = vi.fn<ProviderAuthService["Service"]["tryHandlePromptCommand"]>(
      input?.tryHandlePromptCommandEffect ?? (() => Effect.succeed(false)),
    );
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => input?.interruptTurnEffect?.() ?? Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((stopInput: unknown) =>
      (input?.stopSessionEffect?.() ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const threadId =
              typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
                ? (stopInput as { threadId?: ThreadId }).threadId
                : undefined;
            if (!threadId) {
              return;
            }
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      ),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const pruneWorktrees = vi.fn((_: { readonly cwd: string }) => Effect.void);
    const createWorktree = vi.fn(
      (input: { readonly refName: string; readonly path: string | null }) =>
        Effect.succeed({ worktree: { path: input.path ?? "", refName: input.refName } }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGeneration["Service"]["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGeneration["Service"]["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const usageLimits = input?.usageLimits ?? new Map<ProviderInstanceId, ProviderUsageLimit>();
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        driver: driverKindForInstanceId(modelSelection.instanceId),
        enabled: true,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
        ...input?.primaryProviderSnapshot,
      },
      ...(input?.extraProviderSnapshots ?? []),
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      assertConversationRollbackSupported: () => unsupported(),
      getInstanceInfo: (instanceId) => {
        const driverKind = driverKindForInstanceId(instanceId);
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            // Mirrors production: instances of a driver that share a home
            // directory share a continuation group, so a thread can move
            // between them without losing its resume state.
            // The composite gateway driver adopts the Claude harness key on
            // purpose, which is what lets a started Claude thread move to it.
            continuationKey:
              input?.continuationKeys?.[String(instanceId)] ??
              (driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : driverKind === ProviderDriverKind.make("claudeAgent") ||
                    driverKind === ProviderDriverKind.make("posthogGateway")
                  ? "claude:home:/shared-claude"
                  : `${driverKind}:instance:${instanceId}`),
          },
        });
      },
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    let titleRegenerationCompletionDispatchAttempts = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          dispatch: (command) => {
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            return engine.dispatch(command);
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          subscribeDomainEvents: engine.subscribeDomainEvents,
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provide(Layer.mock(ProviderAuthService, { tryHandlePromptCommand })),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never, usageLimits)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
          pruneWorktrees,
          createWorktree,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest(
          input?.providerInstances !== undefined
            ? ({ providerInstances: input.providerInstances } as never)
            : {},
        ),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      // Shared with the orchestration layers above: the same Layer value is
      // memoised, so the reactor's repositories read what the engine wrote.
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      reactor
        .start()
        .pipe(
          Scope.provide(scope),
          Effect.provideService(ServerActivation, input?.serverActivation),
        ),
    );
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readPendingTurnStarts: () =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly threadId: string }>`
              SELECT thread_id AS "threadId"
              FROM projection_turns
              WHERE turn_id IS NULL AND state = 'pending'
            `;
          }),
        ),
      tryHandlePromptCommand,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      pruneWorktrees,
      createWorktree,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      usageLimits,
      publishRuntimeEvent: (event: ProviderRuntimeEvent) =>
        Effect.runPromise(PubSub.publish(runtimeEventPubSub, event)),
      stateDir,
      drain,
      runEffect,
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }

  effectIt.effect.each(["new", "ready", "stopped"] as const)(
    "handles sign-out for a %s thread before worktree repair, text helpers, or startup",
    (sessionStatus) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-personal");
        const handled = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({
            ...(sessionStatus === "new"
              ? {}
              : {
                  threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
                }),
            tryHandlePromptCommandEffect: () =>
              Deferred.succeed(handled, undefined).pipe(Effect.as(true)),
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        if (sessionStatus !== "new") {
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-sign-out-bound-session"),
            threadId,
            session: {
              threadId,
              providerInstanceId: instanceId,
              providerName: "antigravity",
              status: sessionStatus,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
        }
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-sign-out-worktree"),
          threadId,
          title: "New thread",
          branch: "ras-code/1234abcd",
          worktreePath: NodePath.join(harness.stateDir, "missing-worktree"),
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-provider-sign-out"),
          threadId,
          message: {
            messageId: MessageId.make("message-provider-sign-out"),
            role: "user",
            text: "/logout",
            attachments: [],
          },
          modelSelection: {
            instanceId:
              sessionStatus === "new" ? instanceId : ProviderInstanceId.make("antigravity-other"),
            model: "gemini-3.1-pro",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* Deferred.await(handled);
        yield* Effect.promise(() => harness.drain());

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          providerName: "antigravity",
          providerInstanceId: instanceId,
          activeTurnId: null,
          lastError: null,
        });
        expect(thread?.messages.map((message) => message.text)).toEqual(["/logout"]);
        expect(thread?.activities).toContainEqual(
          expect.objectContaining({ kind: "provider.auth.signed-out", tone: "info", turnId: null }),
        );
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
          instanceId,
          text: "/logout",
          hasAttachments: false,
        });
        expect(harness.pruneWorktrees).not.toHaveBeenCalled();
        expect(harness.createWorktree).not.toHaveBeenCalled();
        expect(harness.generateThreadTitle).not.toHaveBeenCalled();
        expect(harness.generateBranchName).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect("clears a failed sign-out request without sending it as a prompt", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-personal");
      const handled = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
          tryHandlePromptCommandEffect: () =>
            Deferred.succeed(handled, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "logout",
                    detail: "The provider could not sign out. Try again.",
                  }),
                ),
              ),
            ),
        }),
      );
      const threadId = ThreadId.make("thread-1");

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-sign-out-failed"),
        threadId,
        message: {
          messageId: MessageId.make("message-provider-sign-out-failed"),
          role: "user",
          text: "/logout",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(handled);
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: expect.stringContaining("The provider could not sign out. Try again."),
      });
      expect(thread?.activities).toContainEqual(
        expect.objectContaining({ kind: "provider.turn.start.failed", tone: "error" }),
      );
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.auth.signed-out"),
      ).toBe(false);
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect.each([
    { label: "a command mention", text: "What does /logout do?", attachments: [] },
    {
      label: "a command with an attachment",
      text: "/logout",
      attachments: [
        {
          type: "file" as const,
          id: "attached-notes",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        },
      ],
    },
    { label: "another provider's command", text: "/logout", attachments: [] },
  ])("sends $label when the provider auth handler leaves it unhandled", ({ text, attachments }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            Deferred.succeed(started, undefined).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-command-unhandled"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-provider-command-unhandled"),
          role: "user",
          text,
          attachments,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
        instanceId: ProviderInstanceId.make("codex"),
        text,
        hasAttachments: attachments.length > 0,
      });
      expect(harness.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: text,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      );
    }),
  );

  type ReactorHarness = Awaited<ReturnType<typeof createHarness>>;

  /** The one runtime boundary these promise-based tests dispatch through. */
  const dispatchCommand = (
    harness: ReactorHarness,
    command: Parameters<ReactorHarness["engine"]["dispatch"]>[0],
  ) => harness.runEffect(harness.engine.dispatch(command));

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "hello reactor",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  effectIt.effect("retains a turn dispatched immediately after start until activation", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const started = yield* Deferred.make<ProviderSession>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          serverActivation: Deferred.await(activation),
          startSessionEffect: (session) =>
            Deferred.succeed(started, session).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-activation"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-before-activation"),
          role: "user",
          text: "Start after activation",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(yield* Deferred.isDone(started)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      const session = yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());
      expect(session.threadId).toBe(ThreadId.make("thread-1"));
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        input: "Start after activation",
      });
    }),
  );

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("retries thread title generation after a transient failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Claude CLI request timed out.",
              }),
            )
          : Effect.succeed({ title: "Generated title" });
      }),
    );

    await dispatchCommand(harness, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-seed"),
      threadId: ThreadId.make("thread-1"),
      title: seededTitle,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-title"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-title"),
        role: "user",
        text: "Please investigate reconnect failures after restarting the session.",
        attachments: [],
      },
      titleSeed: seededTitle,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
    expect(attempts).toBe(2);
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user message when regeneration context is truncated", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const quoteText = "界".repeat(1_000);
    const citation = serializeAssistantCitation({
      ...assistantCitation,
      text: quoteText,
      end: quoteText.length,
    });
    const firstUserMessage = `Review subagent monitoring risks. ${citation} ${"Opening context. ".repeat(200)}`;
    const recentUserMessage = `LATEST FINDING: ${"implementation detail ".repeat(320)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Review subagent monitoring risks" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing-long"),
        threadId: ThreadId.make("thread-1"),
        title: "Generic PR review",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-long-title-regeneration"),
          role: "user",
          text: firstUserMessage,
          attachments: [
            {
              type: "image",
              id: "opening-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-middle-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("middle-message-before-long-title-regeneration"),
          role: "user",
          text: "Temporary handoff details.",
          attachments: [
            {
              type: "image",
              id: "middle-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recent-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("recent-message-before-long-title-regeneration"),
          role: "user",
          text: recentUserMessage,
          attachments: [
            {
              type: "image",
              id: "recent-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-long"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const input = harness.generateThreadTitle.mock.calls[0]?.[0];
    if (!input) {
      throw new Error("Expected a title generation input");
    }
    const message = input.message;
    expect(message.startsWith(`USER:\nReview subagent monitoring risks. ${quoteText} `)).toBe(true);
    expect(message).not.toContain("ras-code-citation://");
    expect(message).toContain("[First user message truncated]");
    expect(message).toContain("[Earlier content truncated]");
    expect(message).toContain("image.png");
    expect(message).toHaveLength(8_000);
    expect(input.attachments?.map((attachment) => attachment.id)).toEqual([
      "opening-context-image",
      "recent-context-image",
    ]);
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find(
          (entry) => entry.id === asMessageId("user-message-before-long-title-regeneration"),
        )?.text,
    ).toBe(firstUserMessage);
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user context and attachment before the retained tail", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserContext = "USER:\nOld visual issue\n[Attachments: old-issue.png]";
    const truncationMarker = "[Earlier content truncated]\n\n";
    const retainedContext = "x".repeat(
      8_000 - firstUserContext.length - "\n\n".length - truncationMarker.length,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `${firstUserContext}\n\n${truncationMarker}${retainedContext}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        id: "old-title-context-image",
        name: "old-issue.png",
      }),
    ]);
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await dispatchCommand(harness, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-custom"),
      threadId: ThreadId.make("thread-1"),
      title: "Keep this custom title",
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-title-preserve"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-title-preserve"),
        role: "user",
        text: "Please investigate reconnect failures after restarting the session.",
        attachments: [],
      },
      titleSeed: seededTitle,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    const prompt = `[effort:high]\\n\\nFix reconnect spinner on resume ${serializeAssistantCitation(assistantCitation)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await dispatchCommand(harness, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-formatted-seed"),
      threadId: ThreadId.make("thread-1"),
      title: seededTitle,
    });

    const titleUpdated = await harness.runEffect(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.meta-updated" &&
            event.payload.title === "Reconnect spinner resume bug",
        ),
        Stream.take(1),
        Stream.toPull,
        Scope.provide(scope!),
      ),
    );

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-title-formatted"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-title-formatted"),
        role: "user",
        text: prompt,
        attachments: [],
      },
      titleSeed: seededTitle,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await harness.runEffect(titleUpdated);
    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `[effort:high]\\n\\nFix reconnect spinner on resume ${assistantQuoteText}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).not.toContain(
      "ras-code-citation://",
    );
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
    expect(
      thread?.messages.find((entry) => entry.id === asMessageId("user-message-title-formatted"))
        ?.text,
    ).toBe(prompt);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: prompt });
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const prompt = `Add a safer reconnect backoff. ${serializeAssistantCitation(assistantCitation)}`;
    const statusRefreshed = await harness.runEffect(Deferred.make<void>());
    const refreshStatus = harness.refreshStatus.getMockImplementation()!;
    harness.refreshStatus.mockImplementation((cwd) =>
      refreshStatus(cwd).pipe(Effect.tap(() => Deferred.succeed(statusRefreshed, undefined))),
    );

    await dispatchCommand(harness, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-branch"),
      threadId: ThreadId.make("thread-1"),
      branch: "ras-code/1234abcd",
      worktreePath: "/tmp/provider-project-worktree",
    });

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-branch-model"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-branch-model"),
        role: "user",
        text: prompt,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await harness.runEffect(Deferred.await(statusRefreshed));
    await harness.drain();
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).toBe(
      `Add a safer reconnect backoff. ${assistantQuoteText}`,
    );
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).not.toContain(
      "ras-code-citation://",
    );
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find((entry) => entry.id === asMessageId("user-message-branch-model"))?.text,
    ).toBe(prompt);
  });

  it("recreates a missing worktree from the thread branch before starting a turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const worktreePath = NodePath.join(harness.stateDir, "missing-worktree");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/restore",
        worktreePath,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-worktree"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-project" });
    expect(harness.createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-project",
      refName: "feature/restore",
      path: worktreePath,
    });
    expect(harness.createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startSession.mock.invocationCallOrder[0]!,
    );
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-fast"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-fast"),
        role: "user",
        text: "hello fast mode",
        attachments: [],
      },
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-claude-effort"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-claude-effort"),
        role: "user",
        text: "hello with effort",
        attachments: [],
      },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-claude-fast-mode"),
        role: "user",
        text: "hello with fast mode",
        attachments: [],
      },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("cmd-interaction-mode-set-plan"),
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-plan"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-plan"),
        role: "user",
        text: "plan this change",
        attachments: [],
      },
      interactionMode: "plan",
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-unsupported-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-unsupported-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-unsupported-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-unsupported-2"),
        role: "user",
        text: "second",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  effectIt.effect("rejects crossing PostHog gateway harness shapes after start", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          threadModelSelection: {
            instanceId: ProviderInstanceId.make("posthog_gateway"),
            model: "zai-org/glm-5.3-flash",
          },
          extraProviderSnapshots: [
            {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              driver: "claudeAgent",
              enabled: true,
            },
          ],
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-gateway-shape-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-gateway-shape-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-gateway-shape-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-gateway-shape-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads
              .find((entry) => entry.id === ThreadId.make("thread-1"))
              ?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
            false
          );
        }),
      );

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const readModel = yield* Effect.promise(() => harness.readModel());
      expect(
        readModel.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: {
          detail: expect.stringContaining(
            "cannot switch between Claude and open models on PostHog AI Gateway",
          ),
        },
      });
    }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-provider-first"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-provider-first"),
        role: "user",
        text: "hello claude",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-unchanged-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-unchanged-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-unchanged-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-unchanged-2"),
        role: "user",
        text: "second",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-compatible-codex-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-compatible-codex-2"),
        role: "user",
        text: "second",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex_work"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-workspace-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-workspace-1"),
        role: "user",
        text: "first in project root",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await dispatchCommand(harness, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-worktree-change"),
      threadId: ThreadId.make("thread-1"),
      worktreePath: "/tmp/provider-project-worktree",
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-workspace-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-workspace-2"),
        role: "user",
        text: "second in worktree",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-claude-effort-1"),
        role: "user",
        text: "first claude turn",
        attachments: [],
      },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "medium" }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-claude-effort-2"),
        role: "user",
        text: "second claude turn",
        attachments: [],
      },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-runtime-mode-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-1"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-runtime-mode-2"),
        role: "user",
        text: "second",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "claudeAgent",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-restart-failure-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await dispatchCommand(harness, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-provider-switch-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-provider-switch-2"),
        role: "user",
        text: "second",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("provider resume state is incompatible"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "stopped",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-stopped-provider-switch"),
        role: "user",
        text: "continue with claude",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("provider resume state is incompatible"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("turn-1"),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  effectIt.effect(
    "stops a running session and records the failure when provider interrupt fails",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            interruptTurnEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            stopSessionEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider process already exited",
                }),
              ),
          }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-interrupt-failure"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-provider-failure"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const thread = (await harness.readModel()).threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return thread?.session?.status === "stopped";
          }),
        );

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: "provider session disappeared",
        });
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
        ).toMatchObject({
          summary: "Provider turn interrupt failed",
          payload: { detail: "provider session disappeared" },
        });
        expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      }),
  );

  effectIt.effect("stops a starting session without a bound turn when interrupt fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          interruptTurnEffect: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.interrupt",
                detail: "provider session disappeared",
              }),
            ),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-starting"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-starting-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
        lastError: "provider session disappeared",
      });
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toMatchObject({ payload: { detail: "provider session disappeared" } });
    }),
  );

  effectIt.effect("does not overwrite a session that became ready while an interrupt failed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      const completedAt = "2026-01-01T00:00:01.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      harness.interruptTurn.mockImplementation(() =>
        harness.engine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-natural-completion"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          })
          .pipe(
            Effect.catchCause((cause) => Effect.die(cause)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            ),
          ),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toBe(false);
    }),
  );

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-stale"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-stale"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-stale"),
        role: "user",
        text: "resume codex",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-missing-instance"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-missing-instance"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-missing-instance"),
        role: "user",
        text: "resume codex",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-approval"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.approval.respond",
      commandId: CommandId.make("cmd-approval-respond"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("approval-request-1"),
      decision: "accept",
      createdAt: now,
    });

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-user-input"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.user-input.respond",
      commandId: CommandId.make("cmd-user-input-respond"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("user-input-request-1"),
      answers: {
        sandbox_mode: "workspace-write",
      },
      createdAt: now,
    });

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("normalizes stale Codex approval callbacks without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/requestApproval/decision",
          detail: "Unknown pending Codex approval request: approval-request-1",
        }),
      ),
    );

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-approval-error"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-approval-requested"),
      threadId: ThreadId.make("thread-1"),
      activity: {
        id: EventId.make("activity-approval-requested"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "approval-request-1",
          requestKind: "command",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.approval.respond",
      commandId: CommandId.make("cmd-approval-respond-stale"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("approval-request-1"),
      decision: "acceptForSession",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await dispatchCommand(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-user-input-error"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-user-input-requested"),
      threadId: ThreadId.make("thread-1"),
      activity: {
        id: EventId.make("activity-user-input-requested"),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: "user-input-request-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });

    await dispatchCommand(harness, {
      type: "thread.user-input.respond",
      commandId: CommandId.make("cmd-user-input-respond-stale"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("user-input-request-1"),
      answers: {
        sandbox_mode: "workspace-write",
      },
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  describe("usage-limit fallback routing", () => {
    const PRIMARY = ProviderInstanceId.make("claude_subscription");
    const FALLBACK = ProviderInstanceId.make("posthog_gateway");
    const PRIMARY_SELECTION = { instanceId: PRIMARY, model: "claude-sonnet-4-5" } as const;
    const EXHAUSTED: ProviderUsageLimit = {
      status: "exhausted",
      resetsAt: "2099-01-01T00:00:00.000Z",
      kind: "five_hour",
      utilization: 1,
    };

    const fallbackHarnessInput = (overrides?: {
      readonly usageLimits?: Map<ProviderInstanceId, ProviderUsageLimit>;
      readonly requiresNewThreadForModelChange?: boolean;
    }) => ({
      threadModelSelection: PRIMARY_SELECTION,
      usageLimits: overrides?.usageLimits ?? new Map([[PRIMARY, EXHAUSTED]]),
      extraProviderSnapshots: [
        {
          instanceId: FALLBACK,
          driver: "posthogGateway",
          enabled: true,
          displayName: "PostHog AI Gateway",
          models: [
            {
              slug: PRIMARY_SELECTION.model,
              name: "Claude Sonnet 4.5",
              isCustom: false,
              capabilities: null,
            },
          ],
          ...(overrides?.requiresNewThreadForModelChange === true
            ? { requiresNewThreadForModelChange: true }
            : {}),
        },
      ],
      ...(overrides?.requiresNewThreadForModelChange === true
        ? { requiresNewThreadForModelChange: true }
        : {}),
    });

    /**
     * The reactor subscribes to the provider runtime stream on a forked
     * fiber, so the first publish can land before the subscription exists.
     * Publish a harmless "allowed" event until it is observed, which proves
     * the consumer is attached before the test publishes what it cares about.
     */
    const awaitRuntimeSubscriber = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
      await waitFor(async () => {
        await harness.publishRuntimeEvent({
          eventId: EventId.make("runtime-event-probe"),
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: PRIMARY,
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "account.rate-limits.updated",
          payload: {
            rateLimits: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
          },
        });
        return harness.usageLimits.get(PRIMARY)?.status === "ok";
      });
    };

    const dispatchTurn = (harness: Awaited<ReturnType<typeof createHarness>>, commandId: string) =>
      dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const publishUsageLimitFailure = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      eventId: string,
      createdAt: string,
    ) =>
      harness.publishRuntimeEvent({
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt,
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "Claude AI usage limit reached" },
      });

    const findActivity = (
      readModel: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>["readModel"]>>,
      kind: string,
    ) => {
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.activities.find((activity) => activity.kind === kind);
    };

    const fallbackRequestId = (activity: { readonly payload: unknown } | undefined): string => {
      if (activity?.payload === null || typeof activity?.payload !== "object") {
        throw new Error("Fallback offer has no payload.");
      }
      const requestId = (activity.payload as Record<string, unknown>).requestId;
      if (typeof requestId !== "string") {
        throw new Error("Fallback offer has no request id.");
      }
      return requestId;
    };

    const respondToFallbackOffer = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      commandId: string,
      requestId: string,
      decision: "switch" | "wait",
    ) =>
      dispatchCommand(harness, {
        type: "thread.fallback.respond",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make(requestId),
        decision,
        createdAt: "2026-01-01T00:00:02.000Z",
      });

    /** Waits for the (only) open offer, then confirms "switch" on it. */
    const confirmSwitchOnce = async (
      harness: Awaited<ReturnType<typeof createHarness>>,
      commandId: string,
    ) => {
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      const requestId = fallbackRequestId(offer);
      await respondToFallbackOffer(harness, commandId, requestId, "switch");
    };

    it("records the primary's quota windows on the offer it writes", async () => {
      const harness = await createHarness(
        fallbackHarnessInput({
          usageLimits: new Map([
            [
              PRIMARY,
              {
                ...EXHAUSTED,
                windows: [
                  { name: "primary", usedPercent: 100, resetsAt: "2099-01-01T00:00:00.000Z" },
                  { name: "secondary", usedPercent: 100, resetsAt: "2099-01-05T00:00:00.000Z" },
                ],
              },
            ],
          ]),
        }),
      );
      await dispatchTurn(harness, "cmd-fallback-windows");

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      expect(offer?.payload).toMatchObject({
        usageWindows: [
          { name: "primary", usedPercent: 100, resetsAt: "2099-01-01T00:00:00.000Z" },
          { name: "secondary", usedPercent: 100, resetsAt: "2099-01-05T00:00:00.000Z" },
        ],
      });
    });

    it("discovers a PostHog gateway with the same model without a fallback setting", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([[PRIMARY, EXHAUSTED]]),
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: `anthropic/${PRIMARY_SELECTION.model}`,
                name: "Claude Sonnet 4.5",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-implicit");

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      expect(offer?.payload).toMatchObject({
        primaryInstanceId: PRIMARY,
        fallbackInstanceId: FALLBACK,
        model: PRIMARY_SELECTION.model,
        modelLabel: "Claude Sonnet 4.5",
      });
      const requestId = fallbackRequestId(offer);
      await respondToFallbackOffer(harness, "cmd-fallback-implicit-confirm", requestId, "switch");
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
        modelSelection: {
          instanceId: FALLBACK,
          model: `anthropic/${PRIMARY_SELECTION.model}`,
        },
      });
    });

    it("does not offer a gateway that lacks the requested model", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([[PRIMARY, EXHAUSTED]]),
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: "claude-haiku-4-5",
                name: "Claude Haiku 4.5",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-model-missing");

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: PRIMARY,
      });
      expect(findActivity(await harness.readModel(), "provider.fallback.offered")).toBeUndefined();
    });

    const SECOND_SUBSCRIPTION = ProviderInstanceId.make("claude_personal");
    const sonnetModel = {
      slug: PRIMARY_SELECTION.model,
      name: "Claude Sonnet 4.5",
      isCustom: false,
      capabilities: null,
    };
    const gatewaySnapshot = {
      instanceId: FALLBACK,
      driver: "posthogGateway",
      enabled: true,
      displayName: "PostHog AI Gateway",
      models: [sonnetModel],
    };
    const secondSubscriptionSnapshot = {
      instanceId: SECOND_SUBSCRIPTION,
      driver: "claudeAgent",
      enabled: true,
      displayName: "Claude Personal",
      models: [sonnetModel],
    };

    const offeredFallbackInstanceId = async (
      harness: Awaited<ReturnType<typeof createHarness>>,
    ) => {
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      return (offer?.payload as Record<string, unknown> | undefined)?.fallbackInstanceId;
    };

    it("offers another subscription before the metered gateway", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([[PRIMARY, EXHAUSTED]]),
        extraProviderSnapshots: [gatewaySnapshot, secondSubscriptionSnapshot],
      });
      await dispatchTurn(harness, "cmd-fallback-second-subscription");

      expect(await offeredFallbackInstanceId(harness)).toBe(SECOND_SUBSCRIPTION);
    });

    it("skips an instance signed in to the exhausted account", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([[PRIMARY, EXHAUSTED]]),
        primaryProviderSnapshot: {
          auth: { status: "authenticated", email: "work@example.com" },
        },
        extraProviderSnapshots: [
          {
            ...secondSubscriptionSnapshot,
            auth: { status: "authenticated", email: "Work@example.com " },
          },
          gatewaySnapshot,
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-same-account");

      expect(await offeredFallbackInstanceId(harness)).toBe(FALLBACK);
    });

    it("passes over an instance nobody has logged into", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([[PRIMARY, EXHAUSTED]]),
        extraProviderSnapshots: [
          { ...secondSubscriptionSnapshot, auth: { status: "unauthenticated" } },
          gatewaySnapshot,
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-unauthenticated");

      expect(await offeredFallbackInstanceId(harness)).toBe(FALLBACK);
    });

    it("passes over a candidate that is itself out of quota", async () => {
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits: new Map([
          [PRIMARY, EXHAUSTED],
          [SECOND_SUBSCRIPTION, EXHAUSTED],
        ]),
        extraProviderSnapshots: [secondSubscriptionSnapshot, gatewaySnapshot],
      });
      await dispatchTurn(harness, "cmd-fallback-candidate-exhausted");

      expect(await offeredFallbackInstanceId(harness)).toBe(FALLBACK);
    });

    it("carries the transcript home from a subscription with its own home", async () => {
      const primary = ProviderInstanceId.make("claude_work");
      const selection = { instanceId: primary, model: PRIMARY_SELECTION.model } as const;
      const harness = await createHarness({
        threadModelSelection: selection,
        usageLimits: new Map<ProviderInstanceId, ProviderUsageLimit>(),
        continuationKeys: {
          [String(primary)]: "claude:home:/work",
          [String(SECOND_SUBSCRIPTION)]: "claude:home:/personal",
        },
        extraProviderSnapshots: [secondSubscriptionSnapshot],
      });
      await dispatchTurn(harness, "cmd-fallback-home-1");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      // The record a real crossing leaves behind. It is what survives the
      // restart below.
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-fallback-home-engaged"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-fallback-home-engaged"),
            tone: "info",
            kind: "provider.fallback.engaged",
            summary: "Usage limit reached; continuing with Claude Personal.",
            payload: {
              primaryInstanceId: primary,
              fallbackInstanceId: SECOND_SUBSCRIPTION,
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-fallback-home-park"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claudeAgent",
            providerInstanceId: SECOND_SUBSCRIPTION,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      harness.runtimeSessions.length = 0;

      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-home-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const returned = harness.sendTurn.mock.calls[1]?.[0];
      const returnedInput =
        typeof returned === "object" && returned !== null && "input" in returned
          ? returned.input
          : undefined;
      if (typeof returnedInput !== "string") throw new Error("Return prompt was not text.");
      expect(returned).toMatchObject({ modelSelection: selection });
      expect(returnedInput).toMatch(/<\/provider-switch-conversation>\n\nsecond turn$/);
    });

    it("returns to the requested provider after its usage limit clears", async () => {
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>([[PRIMARY, EXHAUSTED]]);
      const harness = await createHarness({
        threadModelSelection: PRIMARY_SELECTION,
        usageLimits,
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: PRIMARY_SELECTION.model,
                name: "Claude Sonnet 4.5",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-return-1");
      await confirmSwitchOnce(harness, "cmd-fallback-return-confirm");
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
      });

      usageLimits.delete(PRIMARY);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-return-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        providerInstanceId: PRIMARY,
        modelSelection: PRIMARY_SELECTION,
      });
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-stale-fallback-exit"),
        provider: ProviderDriverKind.make("posthogGateway"),
        providerInstanceId: FALLBACK,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:05.500Z",
        type: "session.exited",
        payload: { exitKind: "graceful" },
      });
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-returned"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:06.000Z",
        type: "turn.completed",
        payload: { state: "completed" },
      });
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.returned") !== undefined,
      );
    });

    it("resumes the approved gateway without another prompt when the return attempt is still exhausted", async () => {
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>([[PRIMARY, EXHAUSTED]]);
      const harness = await createHarness(fallbackHarnessInput({ usageLimits }));
      await dispatchTurn(harness, "cmd-fallback-resume-1");
      await confirmSwitchOnce(harness, "cmd-fallback-resume-confirm");
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      usageLimits.delete(PRIMARY);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-resume-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await publishUsageLimitFailure(
        harness,
        "runtime-event-return-still-exhausted",
        "2026-01-01T00:00:06.000Z",
      );

      await waitFor(() => usageLimits.get(PRIMARY)?.status === "exhausted");
      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      expect(harness.sendTurn.mock.calls).toHaveLength(3);
      expect(harness.sendTurn.mock.calls[2]?.[0]).toMatchObject({
        modelSelection: { instanceId: FALLBACK, model: PRIMARY_SELECTION.model },
      });
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(
        thread?.activities.filter((activity) => activity.kind === "provider.fallback.offered"),
      ).toHaveLength(1);
    });

    it("offers instead of routing silently when a fresh turn starts with the primary already exhausted", async () => {
      const harness = await createHarness(fallbackHarnessInput());
      await dispatchTurn(harness, "cmd-fallback-1");

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      let sessionStarted = false;
      try {
        await waitFor(() => harness.startSession.mock.calls.length > 0, 300);
        sessionStarted = true;
      } catch {
        // Expected: no session should start while the offer is unanswered.
      }
      expect(sessionStarted).toBe(false);
    });

    it("routes a turn to the fallback instance once the offer is confirmed", async () => {
      const harness = await createHarness(fallbackHarnessInput());
      await dispatchTurn(harness, "cmd-fallback-1");
      await confirmSwitchOnce(harness, "cmd-fallback-1-confirm");

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
        modelSelection: { instanceId: FALLBACK, model: "claude-sonnet-4-5" },
      });
    });

    it("expires an accepted offer when the gateway is no longer available", async () => {
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>([[PRIMARY, EXHAUSTED]]);
      const harness = await createHarness(fallbackHarnessInput({ usageLimits }));
      await dispatchTurn(harness, "cmd-fallback-unavailable");
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");

      usageLimits.set(FALLBACK, EXHAUSTED);
      await respondToFallbackOffer(
        harness,
        "cmd-fallback-unavailable-confirm",
        fallbackRequestId(offer),
        "switch",
      );

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offer-expired") !== undefined,
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("announces the substitution on the thread once confirmed", async () => {
      const harness = await createHarness(fallbackHarnessInput());
      await dispatchTurn(harness, "cmd-fallback-3");
      await confirmSwitchOnce(harness, "cmd-fallback-3-confirm");

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.engaged") !== undefined,
      );
      const notice = findActivity(await harness.readModel(), "provider.fallback.engaged");
      expect(notice?.summary).toBe(
        "Usage limit reached on Claude; continuing with Claude Sonnet 4.5 via PostHog AI Gateway until 2099-01-01T00:00:00.000Z.",
      );
    });

    it("keeps the primary instance when it is not exhausted", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await dispatchTurn(harness, "cmd-fallback-4");

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: PRIMARY,
      });
    });

    it("keeps the primary instance when the fallback is itself exhausted", async () => {
      const harness = await createHarness(
        fallbackHarnessInput({
          usageLimits: new Map([
            [PRIMARY, EXHAUSTED],
            [FALLBACK, EXHAUSTED],
          ]),
        }),
      );
      await dispatchTurn(harness, "cmd-fallback-5");

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: PRIMARY,
      });
    });

    it("records exhaustion from an account.rate-limits.updated event", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-rate-limit"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", resetsAt: 4_070_908_800 },
          },
        },
      });
      await waitFor(() => harness.usageLimits.get(PRIMARY)?.status === "exhausted");

      await dispatchTurn(harness, "cmd-fallback-6");
      await confirmSwitchOnce(harness, "cmd-fallback-6-confirm");
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
      });
    });

    it("offers the fallback instead of retrying silently on a usage-limit turn failure", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-7");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await publishUsageLimitFailure(
        harness,
        "runtime-event-turn-failed",
        "2026-01-01T00:00:01.000Z",
      );

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      // No silent retry: still exactly the one call from the original turn.
      expect(harness.sendTurn.mock.calls.length).toBe(1);
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      expect((offer?.payload as Record<string, unknown>)?.fallbackInstanceId).toBe(FALLBACK);
    });

    it("resumes the same turn on the fallback once the user confirms", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-7");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await publishUsageLimitFailure(
        harness,
        "runtime-event-turn-failed",
        "2026-01-01T00:00:01.000Z",
      );
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      const requestId = fallbackRequestId(offer);

      await respondToFallbackOffer(harness, "cmd-fallback-respond-switch", requestId, "switch");

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
      });
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.engaged") !== undefined,
      );
    });

    it("stays on the primary and records the decision when the user waits", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-7");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await publishUsageLimitFailure(
        harness,
        "runtime-event-turn-failed",
        "2026-01-01T00:00:01.000Z",
      );
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      const requestId = fallbackRequestId(offer);

      await respondToFallbackOffer(harness, "cmd-fallback-respond-wait", requestId, "wait");

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.declined") !== undefined,
      );
      expect(harness.sendTurn.mock.calls.length).toBe(1);

      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-after-wait"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-after-wait"),
          role: "user",
          text: "try the subscription again",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(
        thread?.activities.filter((activity) => activity.kind === "provider.fallback.offered"),
      ).toHaveLength(1);
    });

    it("reports the offer as expired for a stale or already-answered request id", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-7");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await publishUsageLimitFailure(
        harness,
        "runtime-event-turn-failed",
        "2026-01-01T00:00:01.000Z",
      );
      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );

      await respondToFallbackOffer(
        harness,
        "cmd-fallback-respond-stale",
        "not-a-real-request",
        "switch",
      );

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offer-expired") !== undefined,
      );
      expect(harness.sendTurn.mock.calls.length).toBe(1);
    });

    it("moves a started thread to the gateway when it shares its continuation key", async () => {
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>();
      const harness = await createHarness(fallbackHarnessInput({ usageLimits }));
      await dispatchTurn(harness, "cmd-fallback-composite-1");
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      usageLimits.set(PRIMARY, EXHAUSTED);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-composite-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      await confirmSwitchOnce(harness, "cmd-fallback-composite-confirm");

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(
        harness.startSession.mock.calls.some(
          (call) =>
            (call[1] as { readonly providerInstanceId?: ProviderInstanceId }).providerInstanceId ===
            FALLBACK,
        ),
      ).toBe(true);
    });

    it("hands a started Codex thread to the gateway with its transcript", async () => {
      const primary = ProviderInstanceId.make("codex_subscription");
      const selection = { instanceId: primary, model: "gpt-5.6-codex" } as const;
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>();
      const harness = await createHarness({
        threadModelSelection: selection,
        usageLimits,
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: `openai/${selection.model}`,
                name: "GPT-5.6 Codex",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-codex-started-1");
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      usageLimits.set(primary, EXHAUSTED);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-codex-started-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      expect(
        findActivity(await harness.readModel(), "provider.fallback.offered")?.payload,
      ).toMatchObject({ fallbackInstanceId: FALLBACK, restartsSession: true });

      await confirmSwitchOnce(harness, "cmd-fallback-codex-started-confirm");

      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        providerInstanceId: FALLBACK,
        modelSelection: { instanceId: FALLBACK, model: `openai/${selection.model}` },
      });
      expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
      const handoff = harness.sendTurn.mock.calls[1]?.[0];
      const handoffInput =
        typeof handoff === "object" && handoff !== null && "input" in handoff
          ? handoff.input
          : undefined;
      if (typeof handoffInput !== "string") throw new Error("Handoff prompt was not text.");
      expect(handoffInput).toContain("hello reactor");
      expect(handoffInput).toMatch(/<\/provider-switch-conversation>\n\nsecond turn$/);
    });

    it("returns an unstarted Codex thread with a transcript handoff", async () => {
      const primary = ProviderInstanceId.make("codex_subscription");
      const selection = { instanceId: primary, model: "gpt-5.6-codex" } as const;
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>([[primary, EXHAUSTED]]);
      const harness = await createHarness({
        threadModelSelection: selection,
        usageLimits,
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: `openai/${selection.model}`,
                name: "GPT-5.6 Codex",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-codex-1");
      await confirmSwitchOnce(harness, "cmd-fallback-codex-confirm");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-codex-fallback-complete"),
        provider: ProviderDriverKind.make("posthogGateway"),
        providerInstanceId: FALLBACK,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:03.000Z",
        type: "turn.completed",
        payload: { state: "completed" },
      });

      usageLimits.delete(primary);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        providerInstanceId: primary,
        modelSelection: selection,
      });
      expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        modelSelection: selection,
        input: expect.stringContaining("<provider-switch-conversation>"),
      });
      const returnCall = harness.sendTurn.mock.calls[1]?.[0];
      const returnInput =
        typeof returnCall === "object" && returnCall !== null && "input" in returnCall
          ? returnCall.input
          : undefined;
      if (typeof returnInput !== "string") throw new Error("Return prompt was not text.");
      expect(returnInput).toContain("hello reactor");
      expect(returnInput).toMatch(/<\/provider-switch-conversation>\n\nsecond turn$/);
      expect(returnInput.split("second turn")).toHaveLength(2);

      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-codex-return-still-exhausted"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: primary,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:06.000Z",
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "usage limit reached" },
      });
      await waitFor(() => usageLimits.get(primary)?.status === "exhausted");
      await waitFor(async () => {
        const failed = findActivity(await harness.readModel(), "provider.turn.start.failed");
        return harness.sendTurn.mock.calls.length === 3 || failed !== undefined;
      });
      expect(findActivity(await harness.readModel(), "provider.turn.start.failed")).toBeUndefined();
      expect(harness.sendTurn.mock.calls[2]?.[0]).toMatchObject({
        modelSelection: { instanceId: FALLBACK, model: `openai/${selection.model}` },
      });
    });

    it("resumes a reaped gateway session instead of refusing the turn", async () => {
      const primary = ProviderInstanceId.make("codex");
      const selection = { instanceId: primary, model: "gpt-5.6-codex" } as const;
      const harness = await createHarness({
        threadModelSelection: selection,
        usageLimits: new Map<ProviderInstanceId, ProviderUsageLimit>([[primary, EXHAUSTED]]),
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: `openai/${selection.model}`,
                name: "GPT-5.6 Codex",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-reaped-1");
      await confirmSwitchOnce(harness, "cmd-fallback-reaped-confirm");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      // The reaper stops an idle session, leaving the thread bound to the
      // gateway in the read model with no live session behind it.
      harness.runtimeSessions.length = 0;

      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-reaped-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(async () => {
        const failed = findActivity(await harness.readModel(), "provider.turn.start.failed");
        return harness.sendTurn.mock.calls.length === 2 || failed !== undefined;
      });
      expect(findActivity(await harness.readModel(), "provider.turn.start.failed")).toBeUndefined();
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        modelSelection: { instanceId: FALLBACK },
      });
    });

    it("carries the transcript home when a restart forgot the thread was on the gateway", async () => {
      const primary = ProviderInstanceId.make("codex_subscription");
      const selection = { instanceId: primary, model: "gpt-5.6-codex" } as const;
      const harness = await createHarness({
        threadModelSelection: selection,
        usageLimits: new Map<ProviderInstanceId, ProviderUsageLimit>(),
        extraProviderSnapshots: [
          {
            instanceId: FALLBACK,
            driver: "posthogGateway",
            enabled: true,
            displayName: "PostHog AI Gateway",
            models: [
              {
                slug: `openai/${selection.model}`,
                name: "GPT-5.6 Codex",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      });
      await dispatchTurn(harness, "cmd-fallback-restart-1");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      // A restart keeps the bound session and the crossing activity in the
      // read model. It drops the live sessions and the in-memory route.
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-fallback-restart-engaged"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-fallback-restart-engaged"),
            tone: "info",
            kind: "provider.fallback.engaged",
            summary: "Usage limit reached; continuing via PostHog AI Gateway.",
            payload: { primaryInstanceId: primary, fallbackInstanceId: FALLBACK },
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-fallback-restart-park"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "posthogGateway",
            providerInstanceId: FALLBACK,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      harness.runtimeSessions.length = 0;

      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-restart-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const returned = harness.sendTurn.mock.calls[1]?.[0];
      const returnedInput =
        typeof returned === "object" && returned !== null && "input" in returned
          ? returned.input
          : undefined;
      if (typeof returnedInput !== "string") throw new Error("Return prompt was not text.");
      expect(returned).toMatchObject({ modelSelection: selection });
      expect(returnedInput).toContain("hello reactor");
      expect(returnedInput).toMatch(/<\/provider-switch-conversation>\n\nsecond turn$/);
    });

    it("keeps the primary instance mid-thread when the driver forbids switching", async () => {
      const usageLimits = new Map<ProviderInstanceId, ProviderUsageLimit>();
      const harness = await createHarness(
        fallbackHarnessInput({ usageLimits, requiresNewThreadForModelChange: true }),
      );
      await dispatchTurn(harness, "cmd-fallback-9");
      await waitFor(() => harness.startSession.mock.calls.length === 1);

      usageLimits.set(PRIMARY, EXHAUSTED);
      await dispatchCommand(harness, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-fallback-10"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(
        harness.startSession.mock.calls.some(
          (call) =>
            (call[1] as { readonly providerInstanceId?: ProviderInstanceId }).providerInstanceId ===
            FALLBACK,
        ),
      ).toBe(false);
    });

    it("records the reset instant the failure message named", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-reset-instant");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const nowMs = await harness.runEffect(Clock.currentTimeMillis);
      const resetsAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + 3 * 24 * 60 * 60 * 1000));
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-turn-failed-reset-instant"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: `Claude AI usage limit reached, try again at ${resetsAt}`,
        },
      });

      await waitFor(() => harness.usageLimits.get(PRIMARY)?.status === "exhausted");
      expect(harness.usageLimits.get(PRIMARY)?.resetsAt).toBe(resetsAt);
    });

    it("does not retry a usage-limit failure that already produced assistant output", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-8");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-content"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Sure — looking at the repo now." },
      });
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-turn-failed-2"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:02.000Z",
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "Claude AI usage limit reached" },
      });

      await Effect.runPromise(Effect.yieldNow);
      await Effect.runPromise(Effect.yieldNow);
      expect(harness.sendTurn.mock.calls.length).toBe(1);
    });

    it("retries when the only assistant text is the provider echoing its API error", async () => {
      const harness = await createHarness(fallbackHarnessInput({ usageLimits: new Map() }));
      await awaitRuntimeSubscriber(harness);
      await dispatchTurn(harness, "cmd-fallback-9");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const errorText =
        "API Error: Server is temporarily limiting requests · You have exceeded your usage limit for this period.";
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-echo-item"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        type: "item.started",
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-echo-delta"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:01.500Z",
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: errorText },
      });
      await harness.publishRuntimeEvent({
        eventId: EventId.make("runtime-event-turn-failed-3"),
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PRIMARY,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-01-01T00:00:02.000Z",
        type: "turn.completed",
        payload: { state: "failed", errorMessage: errorText },
      });

      await waitFor(
        async () =>
          findActivity(await harness.readModel(), "provider.fallback.offered") !== undefined,
      );
      const offer = findActivity(await harness.readModel(), "provider.fallback.offered");
      const requestId = fallbackRequestId(offer);
      await respondToFallbackOffer(harness, "cmd-fallback-respond-echo", requestId, "switch");

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        modelSelection: expect.objectContaining({ instanceId: FALLBACK }),
      });
    });
  });

  effectIt.effect("stops a ready provider session after automatic settlement", () =>
    Effect.gen(function* () {
      const sessionStopped = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          stopSessionEffect: () => Deferred.succeed(sessionStopped, undefined).pipe(Effect.asVoid),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-auto-settle"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const beforeSettlement = yield* Effect.promise(() => harness.readModel());

      yield* harness.engine.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto-settle-with-session"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: beforeSettlement.snapshotSequence,
        settledAt: now,
      });

      yield* Deferred.await(sessionStopped);
      yield* Effect.promise(() => harness.drain());
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.settledOverride).toBe("settled");
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    }),
  );
});
