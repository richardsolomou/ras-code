import {
  ApprovalRequestId,
  type ChatAttachment,
  CommandId,
  EventId,
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderUsageLimitWindow,
  type ProviderRuntimeEvent,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationThreadActivityTone,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type ServerProvider,
  PROVIDER_DISPLAY_NAMES,
  type TurnId,
} from "@t3tools/contracts";
import {
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_BRANCH_PREFIXES,
} from "@t3tools/shared/git";
import { isPostHogGatewayCrossShapeModelChange } from "@t3tools/shared/posthogGateway";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { resolveForkResumeCursor } from "../forkResume.ts";
import { withForkTranscript, withProviderSwitchTranscript } from "../forkTranscript.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  exhaustedUsageLimitFromError,
  hasMeaningfulAssistantText,
  isUsageLimitFailureMessage,
  PASSIVE_ITEM_TYPES,
  providerUsageLimitFromWindows,
} from "../../provider/providerUsageLimit.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const POSTHOG_GATEWAY_DRIVER = ProviderDriverKind.make("posthogGateway");

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.fallback-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function modelIdsMatch(left: string, right: string): boolean {
  return (
    left === right ||
    (!left.includes("/") && right.endsWith(`/${left}`)) ||
    (!right.includes("/") && left.endsWith(`/${right}`))
  );
}
const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = assistantCitationsToPlainText(message.text).trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const matchedPrefix = WORKTREE_BRANCH_PREFIXES.find((prefix) =>
    normalized.startsWith(`${prefix}/`),
  );
  const withoutPrefix =
    matchedPrefix === undefined ? normalized : normalized.slice(`${matchedPrefix}/`.length);

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

/**
 * Label a provider instance for a user-facing notice. Display names are
 * optional on the snapshot; the instance id is always meaningful.
 */
function providerDisplayLabel(
  snapshot: ServerProvider | undefined,
  instanceId: ProviderInstanceId,
): string {
  return (
    snapshot?.displayName ??
    (snapshot ? PROVIDER_DISPLAY_NAMES[snapshot.driver] : undefined) ??
    String(instanceId)
  );
}

/**
 * The account an instance is logged into, when it reports one. Two instances
 * with the same account share one quota pool.
 */
function providerAccountKey(snapshot: ServerProvider | undefined): string | undefined {
  const email = snapshot?.auth?.email?.trim().toLowerCase();
  return email !== undefined && email.length > 0 ? email : undefined;
}

/**
 * Rank a fallback candidate; the lowest rank wins. Another subscription costs
 * nothing per turn, so it beats the metered gateway. Inside a tier, an
 * instance that shares the primary's resume state keeps the conversation in
 * place.
 */
function fallbackCandidateRank(candidate: {
  readonly snapshot: ServerProvider;
  readonly sharesContinuation: boolean;
}): number {
  return (
    (candidate.snapshot.driver === POSTHOG_GATEWAY_DRIVER ? 2 : 0) +
    (candidate.sharesContinuation ? 0 : 1)
  );
}

function formatFallbackNotice(input: {
  readonly primaryLabel: string;
  readonly fallbackLabel: string;
  readonly modelLabel: string;
  readonly resetsAt: string | null;
}): string {
  // The instant is rendered verbatim; clients localise it from the activity
  // payload's `resetsAt`.
  const until = input.resetsAt ?? "further notice";
  return `Usage limit reached on ${input.primaryLabel}; continuing with ${input.modelLabel} via ${input.fallbackLabel} until ${until}.`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerSessionRuntimeRepository =
    yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const serverRequestId = () => crypto.randomUUIDv4.pipe(Effect.map(ApprovalRequestId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const compactingThreadIds = new Set<ThreadId>();
  const stoppingThreadIds = new Set<ThreadId>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to recreate worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const currentProvider = providers.find(
      (snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId,
    );
    const requestedProvider = providers.find(
      (snapshot) => snapshot.instanceId === requestedModelSelection.instanceId,
    );
    const crossShapeGatewayChange = isPostHogGatewayCrossShapeModelChange({
      currentDriver: currentProvider?.driver,
      currentModel: input.currentModelSelection.model,
      nextDriver: requestedProvider?.driver,
      nextModel: requestedModelSelection.model,
    });
    const requiresNewThread =
      currentProvider?.requiresNewThreadForModelChange === true ||
      requestedProvider?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread && !crossShapeGatewayChange) {
      return;
    }
    const detail = crossShapeGatewayChange
      ? `Thread '${input.threadId}' cannot switch between Claude and open models on PostHog AI Gateway after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`
      : `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`;
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail,
    });
  });

  /**
   * One notice per exhaustion episode per thread. Keyed on the reset instant
   * so a later exhaustion (a new window) speaks up again, while every turn
   * inside one window stays quiet.
   */
  const announcedFallbacks = new Map<ThreadId, string>();

  const appendThreadActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: OrchestrationThreadActivityTone;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId(`activity-${input.kind}`),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
      Effect.asVoid,
    );

  const appendFallbackActivity = (input: {
    readonly threadId: ThreadId;
    readonly summary: string;
    readonly primaryInstanceId: ProviderInstanceId;
    readonly fallbackInstanceId: ProviderInstanceId;
    readonly model: string;
    readonly modelLabel: string;
    readonly resetsAt: string | null;
    readonly createdAt: string;
    readonly requestId?: ApprovalRequestId;
  }) =>
    appendThreadActivity({
      threadId: input.threadId,
      tone: "info",
      kind: "provider.fallback.engaged",
      summary: input.summary,
      payload: {
        primaryInstanceId: input.primaryInstanceId,
        fallbackInstanceId: input.fallbackInstanceId,
        model: input.model,
        modelLabel: input.modelLabel,
        resetsAt: input.resetsAt,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      },
      createdAt: input.createdAt,
    });

  const appendFallbackOfferActivity = (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly primaryLabel: string;
    readonly fallbackLabel: string;
    readonly primaryInstanceId: ProviderInstanceId;
    readonly fallbackInstanceId: ProviderInstanceId;
    readonly model: string;
    readonly modelLabel: string;
    readonly resetsAt: string | null;
    readonly restartsSession: boolean;
    // The primary's reported quota windows at the moment it ran dry. Written
    // for diagnosis only: nothing reads it back, and quota state is otherwise
    // in-memory, so an exhaustion leaves no other trace of which window
    // caused it.
    readonly usageWindows: ReadonlyArray<ProviderUsageLimitWindow> | null;
    readonly createdAt: string;
  }) =>
    appendThreadActivity({
      threadId: input.threadId,
      tone: "approval",
      kind: "provider.fallback.offered",
      summary: `${input.primaryLabel} reached its usage limit. Offered ${input.modelLabel} via ${input.fallbackLabel}.`,
      payload: {
        requestId: input.requestId,
        primaryInstanceId: input.primaryInstanceId,
        fallbackInstanceId: input.fallbackInstanceId,
        model: input.model,
        modelLabel: input.modelLabel,
        resetsAt: input.resetsAt,
        restartsSession: input.restartsSession,
        usageWindows: input.usageWindows,
      },
      createdAt: input.createdAt,
    });

  const appendFallbackDeclinedActivity = (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly primaryLabel: string;
    readonly createdAt: string;
  }) =>
    appendThreadActivity({
      threadId: input.threadId,
      tone: "info",
      kind: "provider.fallback.declined",
      summary: `Staying on ${input.primaryLabel}. Resend once its usage limit resets.`,
      payload: { requestId: input.requestId },
      createdAt: input.createdAt,
    });

  const appendFallbackOfferExpiredActivity = (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly createdAt: string;
  }) =>
    appendThreadActivity({
      threadId: input.threadId,
      tone: "error",
      kind: "provider.fallback.offer-expired",
      summary: "That fallback offer is no longer available. Resend your message to try again.",
      payload: { requestId: input.requestId },
      createdAt: input.createdAt,
    });

  const appendFallbackReturnedActivity = (input: {
    readonly threadId: ThreadId;
    readonly primaryLabel: string;
    readonly primaryInstanceId: ProviderInstanceId;
    readonly fallbackInstanceId: ProviderInstanceId;
    readonly model: string;
    readonly modelLabel: string;
    readonly createdAt: string;
  }) =>
    appendThreadActivity({
      threadId: input.threadId,
      tone: "info",
      kind: "provider.fallback.returned",
      summary: `Back on ${input.primaryLabel} with ${input.modelLabel}.`,
      payload: {
        primaryInstanceId: input.primaryInstanceId,
        fallbackInstanceId: input.fallbackInstanceId,
        model: input.model,
        modelLabel: input.modelLabel,
      },
      createdAt: input.createdAt,
    });

  /**
   * The usage-limit crossing this thread is on: the last
   * `provider.fallback.engaged` with no later `provider.fallback.returned`.
   * Read from persisted activities because `activeFallbackRoutes` lives in
   * memory, and a restart would strand the next turn with no context.
   */
  const openFallbackCrossing = Effect.fn("openFallbackCrossing")(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, {
        activityKinds: ["provider.fallback.engaged", "provider.fallback.returned"],
      })
      .pipe(Effect.map(Option.getOrUndefined));
    let crossing: { readonly primary: string; readonly fallback: string } | undefined;
    for (const activity of thread?.activities ?? []) {
      if (activity.kind === "provider.fallback.returned") {
        crossing = undefined;
        continue;
      }
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const primary = payload?.primaryInstanceId;
      const fallback = payload?.fallbackInstanceId;
      if (typeof primary === "string" && typeof fallback === "string") {
        crossing = { primary, fallback };
      }
    }
    return crossing;
  });

  /**
   * Whether this turn must carry the thread's transcript: the instance about
   * to run it cannot resume the conversation the bound session holds. True in
   * both directions of a crossing, out and back.
   *
   * The turn must follow a recorded crossing. That is what keeps a user's own
   * switch between incompatible instances a refusal.
   */
  const requiresTranscriptHandoff = Effect.fn("requiresTranscriptHandoff")(function* (input: {
    readonly threadId: ThreadId;
    readonly sessionInstanceId: ProviderInstanceId | null | undefined;
    readonly desiredInstanceId: ProviderInstanceId;
  }) {
    const sessionInstanceId = input.sessionInstanceId;
    if (
      sessionInstanceId === null ||
      sessionInstanceId === undefined ||
      sessionInstanceId === input.desiredInstanceId
    ) {
      return false;
    }
    const crossing = yield* openFallbackCrossing(input.threadId);
    if (crossing === undefined) {
      return false;
    }
    const returning =
      crossing.fallback === sessionInstanceId && crossing.primary === input.desiredInstanceId;
    const leaving =
      crossing.primary === sessionInstanceId &&
      crossing.fallback === input.desiredInstanceId &&
      // A source with quota again is a user switching back into the old
      // fallback, not a new crossing.
      (yield* providerRegistry.getProviderUsageLimit(sessionInstanceId))?.status === "exhausted";
    if (!returning && !leaving) {
      return false;
    }
    const instanceInfo = yield* Effect.all({
      bound: providerService.getInstanceInfo(sessionInstanceId),
      desired: providerService.getInstanceInfo(input.desiredInstanceId),
    }).pipe(Effect.orElseSucceed(() => undefined));
    return (
      instanceInfo !== undefined &&
      instanceInfo.bound.continuationIdentity.continuationKey !==
        instanceInfo.desired.continuationIdentity.continuationKey
    );
  });

  /**
   * Pick the instance that can serve this selection while the primary is out
   * of quota, or `undefined` when none can. An instance that shares a
   * continuation key resumes the thread's conversation. The rest start a fresh
   * session and carry the transcript, which `restartsSession` reports.
   *
   * Candidates are other instances of the primary's driver, such as a personal
   * Codex account beside a work one, plus the gateway. A third harness that
   * advertises the same model slug is not a candidate: different tool,
   * different bill.
   */
  const resolveFallbackSelection = Effect.fn("resolveFallbackSelection")(function* (input: {
    readonly selection: ModelSelection;
    readonly hasStartedSession: boolean;
  }) {
    const primaryUsage = yield* providerRegistry.getProviderUsageLimit(input.selection.instanceId);
    if (primaryUsage?.status !== "exhausted") {
      return undefined;
    }

    const providers = yield* providerRegistry.getProviders;
    const primarySnapshot = providers.find(
      (snapshot) => snapshot.instanceId === input.selection.instanceId,
    );
    // The gateway is the last resort, so it never falls back to anything.
    if (primarySnapshot?.driver === POSTHOG_GATEWAY_DRIVER) {
      return undefined;
    }
    if (input.hasStartedSession && primarySnapshot?.requiresNewThreadForModelChange === true) {
      return undefined;
    }
    const primaryAccount = providerAccountKey(primarySnapshot);
    const eligible = providers.filter((snapshot) => {
      const supportsModel = snapshot.models?.some((model) =>
        modelIdsMatch(model.slug, input.selection.model),
      );
      return (
        snapshot.instanceId !== input.selection.instanceId &&
        (snapshot.driver === primarySnapshot?.driver ||
          snapshot.driver === POSTHOG_GATEWAY_DRIVER) &&
        snapshot.enabled &&
        snapshot.installed !== false &&
        snapshot.status !== "error" &&
        snapshot.status !== "disabled" &&
        isProviderAvailable(snapshot) &&
        // An instance with no login cannot run the turn. `unknown` stays
        // eligible, because the probe could not tell either way.
        snapshot.auth?.status !== "unauthenticated" &&
        supportsModel === true &&
        // One login is one quota pool, so the second instance fails the
        // same way.
        (primaryAccount === undefined || providerAccountKey(snapshot) !== primaryAccount) &&
        !(input.hasStartedSession && snapshot.requiresNewThreadForModelChange === true)
      );
    });
    if (eligible.length === 0) {
      return undefined;
    }

    const primaryInfo = yield* providerService
      .getInstanceInfo(input.selection.instanceId)
      .pipe(Effect.orElseSucceed(() => undefined));
    const ranked = yield* Effect.forEach(
      eligible,
      (snapshot, index) =>
        Effect.gen(function* () {
          const usage = yield* providerRegistry.getProviderUsageLimit(snapshot.instanceId);
          if (usage?.status === "exhausted") {
            return undefined;
          }
          const info = yield* providerService
            .getInstanceInfo(snapshot.instanceId)
            .pipe(Effect.orElseSucceed(() => undefined));
          const sharesContinuation =
            primaryInfo !== undefined &&
            info !== undefined &&
            primaryInfo.continuationIdentity.continuationKey ===
              info.continuationIdentity.continuationKey;
          return { snapshot, sharesContinuation, index } as const;
        }),
      { concurrency: "unbounded" },
    );
    const [best] = ranked
      .filter((candidate) => candidate !== undefined)
      .toSorted(
        (left, right) =>
          fallbackCandidateRank(left) - fallbackCandidateRank(right) || left.index - right.index,
      );
    if (best === undefined) {
      return undefined;
    }
    const fallbackSnapshot = best.snapshot;
    const sharesContinuation = best.sharesContinuation;
    const fallbackModel = fallbackSnapshot.models.find((model) =>
      modelIdsMatch(model.slug, input.selection.model),
    );
    if (fallbackModel === undefined) {
      return undefined;
    }
    const primaryModel = primarySnapshot?.models?.find((model) =>
      modelIdsMatch(model.slug, input.selection.model),
    );

    return {
      // A started thread that cannot resume on the fallback continues as a
      // fresh session with the transcript, which the offer calls a restart.
      restartsSession: input.hasStartedSession && !sharesContinuation,
      selection: {
        ...input.selection,
        instanceId: fallbackSnapshot.instanceId,
        model: fallbackModel.slug,
      } satisfies ModelSelection,
      primaryLabel: providerDisplayLabel(primarySnapshot, input.selection.instanceId),
      fallbackLabel: providerDisplayLabel(fallbackSnapshot, fallbackSnapshot.instanceId),
      modelLabel:
        primaryModel?.shortName ??
        primaryModel?.name ??
        fallbackModel.shortName ??
        fallbackModel.name,
      primaryInstanceId: input.selection.instanceId,
      sharesContinuation,
      resetsAt: primaryUsage.resetsAt,
      usageWindows: primaryUsage.windows ?? null,
    } as const;
  });

  /**
   * Gathers the persisted state `resolveForkResumeCursor` decides from: the
   * parent's provider runtime row, both continuation identities, and the
   * parent's turn projection. Every read degrades to "cannot branch", which
   * the caller answers with a transcript handoff.
   */
  const resolveForkResumeCursorForThread = Effect.fnUntraced(function* (input: {
    readonly forkedFrom: { readonly threadId: ThreadId; readonly turnCount: number } | null;
    readonly desiredInstanceId: ProviderInstanceId;
  }) {
    const forkedFrom = input.forkedFrom;
    if (!forkedFrom || forkedFrom.turnCount === 0) {
      return undefined;
    }

    const parentRuntime = yield* providerSessionRuntimeRepository
      .getByThreadId({ threadId: forkedFrom.threadId })
      .pipe(
        Effect.orElseSucceed(() => Option.none<ProviderSessionRuntime.ProviderSessionRuntime>()),
      );
    if (Option.isNone(parentRuntime) || parentRuntime.value.providerInstanceId === null) {
      return undefined;
    }
    const parentInstanceId = parentRuntime.value.providerInstanceId;

    const [parentInfo, desiredInfo] = yield* Effect.all(
      [
        providerService.getInstanceInfo(parentInstanceId),
        providerService.getInstanceInfo(input.desiredInstanceId),
      ],
      { concurrency: 2 },
    ).pipe(Effect.orElseSucceed(() => [undefined, undefined] as const));

    const parentTurns = yield* projectionTurnRepository
      .listByThreadId({ threadId: forkedFrom.threadId })
      .pipe(Effect.orElseSucceed(() => []));

    return resolveForkResumeCursor({
      forkedFrom,
      parentResumeCursor: parentRuntime.value.resumeCursor,
      parentContinuationKey: parentInfo?.continuationIdentity.continuationKey,
      desiredContinuationKey: desiredInfo?.continuationIdentity.continuationKey,
      parentTurns,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly freshProviderHandoff?: boolean;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    // With no live session the thread's own selection is not necessarily
    // where its conversation lives: a fallback crossing leaves the bound
    // session on the gateway, and calling the selection "current" would read
    // the next turn as a switch into the gateway and refuse it. An instance
    // that no longer exists is ignored rather than failing the turn.
    const boundInstanceId = thread.session?.providerInstanceId ?? null;
    const knownBoundInstanceId =
      boundInstanceId === null
        ? undefined
        : yield* providerService.getInstanceInfo(boundInstanceId).pipe(
            Effect.as(boundInstanceId),
            Effect.orElseSucceed(() => undefined),
          );
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : (knownBoundInstanceId ?? thread.modelSelection.instanceId);
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null && options?.freshProviderHandoff !== true) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    const incompatibleInstanceChange =
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId &&
      currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey;
    if (incompatibleInstanceChange && options?.freshProviderHandoff !== true) {
      // Driver kinds may differ as long as the resume state matches — a
      // composite driver adopts the continuation key of the harness it wraps
      // so it can pick up a thread that harness started.
      return yield* new ProviderAdapterRequestError({
        provider: preferredProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
      });
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService
        .startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(thread.title ? { title: thread.title } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        })
        .pipe(Effect.tap(() => refreshWorkspaceSnapshot));

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return existingSessionThreadId;
      }

      const resumeCursor =
        shouldRestartForModelChange || incompatibleInstanceChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    // Cold start. A fork gets one chance to become a real branch of its
    // parent's provider conversation; after this session exists, later
    // restarts resume the fork's own session like any other thread.
    const forkResumeCursor = yield* resolveForkResumeCursorForThread({
      forkedFrom: thread.forkedFrom ?? null,
      desiredInstanceId,
    });
    if (forkResumeCursor !== undefined) {
      yield* Effect.logInfo("provider command reactor forking provider session", {
        threadId,
        sourceThreadId: thread.forkedFrom?.threadId,
        turnCount: thread.forkedFrom?.turnCount,
      });
    }
    const startedSession = yield* startProviderSession(
      forkResumeCursor !== undefined ? { resumeCursor: forkResumeCursor } : undefined,
    );
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly requestedModelSelection?: ModelSelection;
    readonly messageId?: string;
    readonly freshProviderHandoff?: boolean;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
      ...(input.freshProviderHandoff === true ? { freshProviderHandoff: true } : {}),
    });
    if (input.requestedModelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.requestedModelSelection);
    }
    // A fork that could not branch its parent's provider conversation carries
    // the parent's transcript into its opening prompt instead.
    //
    // "Has this fork's provider seen the context yet" is read from the thread's
    // own assistant messages rather than its turn count: a first turn that
    // failed leaves a turn behind but no answer, and the retry still needs the
    // handoff.
    const forkedFrom = thread.forkedFrom ?? null;
    // Only a fork handoff or a provider switch reads history; an ordinary turn
    // keeps the shell read.
    const priorMessages =
      forkedFrom !== null || input.freshProviderHandoff === true
        ? ((yield* resolveThreadDetail(input.threadId))?.messages ?? [])
        : [];
    const forkContextDelivered =
      forkedFrom === null ||
      priorMessages.some((message) => message.role === "assistant" && message.inherited !== true);
    const messageTextWithForkContext =
      forkedFrom !== null &&
      !forkContextDelivered &&
      (yield* resolveForkResumeCursorForThread({
        forkedFrom,
        desiredInstanceId: (input.modelSelection ?? thread.modelSelection).instanceId,
      })) === undefined
        ? withForkTranscript({
            messageText: input.messageText,
            inheritedMessages: priorMessages.filter((message) => message.inherited === true),
          })
        : input.messageText;
    const messageText =
      input.freshProviderHandoff === true
        ? withProviderSwitchTranscript({
            messageText: messageTextWithForkContext,
            priorMessages: priorMessages.filter(
              (message) => message.id !== input.messageId && !message.streaming,
            ),
          })
        : messageTextWithForkContext;
    const normalizedInput = toNonEmptyProviderInput(messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  type ActiveFallbackRoute = {
    readonly primarySelection: ModelSelection;
    readonly fallbackSelection: ModelSelection;
    readonly primaryLabel: string;
    readonly fallbackLabel: string;
    readonly modelLabel: string;
    readonly resetsAt: string | null;
    readonly sharesContinuation: boolean;
  };

  type PendingTurnAttempt = {
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly instanceId: ProviderInstanceId;
    readonly onFallback: boolean;
    readonly returningFromFallback?: ActiveFallbackRoute;
    /** Streamed assistant text, capped; compared against the failure message on error. */
    assistantText: string;
    /** Tool calls, plans, and other non-message items: work a retry would repeat. */
    sawWorkItem: boolean;
  };

  /** At most one in-flight turn per thread, so a plain map is enough. */
  const pendingTurnAttempts = new Map<ThreadId, PendingTurnAttempt>();
  const activeFallbackRoutes = new Map<ThreadId, ActiveFallbackRoute>();
  const declinedFallbacks = new Map<ThreadId, ProviderInstanceId>();
  const clearAnnouncedFallbacks = (threadId: ThreadId) => announcedFallbacks.delete(threadId);

  type PendingFallbackDecision = {
    readonly requestId: ApprovalRequestId;
    readonly pending: PendingTurnAttempt;
    readonly primaryLabel: string;
    readonly fallbackLabel: string;
    readonly primaryInstanceId: ProviderInstanceId;
  };

  /**
   * A usage-limit failure awaiting the user's switch-or-wait decision, kept
   * in memory only: it holds the exact turn to resume, so it cannot outlive
   * this server process. A restart loses it; the client then sees an
   * `offer-expired` reply if the user tries to act on the stale prompt.
   */
  const pendingFallbackDecisions = new Map<ThreadId, PendingFallbackDecision>();

  /**
   * Failure handling for a turn start: mark the thread's session errored and
   * append the failure to the thread's activity. `recover` is the total
   * variant used where the failure has nowhere left to go.
   */
  const makeTurnStartFailureHandlers = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) => {
    const handle = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };
    const recover = (cause: Cause.Cause<unknown>) =>
      handle(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    return recover;
  };

  const dispatchTurn = Effect.fn("dispatchTurn")(function* (input: {
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly requestedModelSelection?: ModelSelection;
    readonly freshProviderHandoff?: boolean;
  }) {
    const recover = makeTurnStartFailureHandlers(input.event);
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: input.event.payload.threadId,
      messageText: input.messageText,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.requestedModelSelection !== undefined
        ? { requestedModelSelection: input.requestedModelSelection }
        : {}),
      messageId: input.event.payload.messageId,
      ...(input.freshProviderHandoff === true ? { freshProviderHandoff: true } : {}),
      interactionMode: input.event.payload.interactionMode,
      createdAt: input.event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => recover(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      pendingTurnAttempts.delete(input.event.payload.threadId);
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.asVoid, Effect.catchCause(recover), Effect.forkScoped);
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      return;
    }
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });

    const recoverTurnStartFailure = makeTurnStartFailureHandlers(event);

    const authCommandHandled = yield* Effect.gen(function* () {
      // Native account commands belong to the thread's existing provider session.
      const instanceId =
        thread.session?.providerInstanceId ??
        event.payload.modelSelection?.instanceId ??
        thread.modelSelection.instanceId;
      const handled = yield* providerAuthService.tryHandlePromptCommand({
        instanceId,
        text: message.text,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });
      if (!handled) {
        return false;
      }

      const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: instanceInfo.driverKind,
          providerInstanceId: instanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provider-sign-out"),
        threadId: thread.id,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.auth.signed-out",
          summary: "Provider signed out",
          payload: { providerInstanceId: instanceId },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return true;
    }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))));
    if (authCommandHandled) {
      return;
    }

    yield* ensureThreadWorktree(thread);

    const isCompactCommand = isCompactCommandMessage(message);
    const nonCompactUserMessageCount = thread.messages.filter(
      (entry) => entry.role === "user" && !isCompactCommandMessage(entry),
    ).length;
    if (nonCompactUserMessageCount === 1 && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    let compactionSessionEnsured = false;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
          Effect.asVoid,
        );
      }
      return appendTurnStartFailure("Context compaction failed", detail).pipe(
        Effect.ensuring(
          restoreCompaction(event.payload.threadId).pipe(
            Effect.catchCause((restoreCause) =>
              Effect.logWarning("failed to restore provider session after compaction failure", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(restoreCause),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover compaction failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    if (isCompactCommand) {
      if (nonCompactUserMessageCount === 0) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running"
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      yield* Effect.gen(function* () {
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.payload.createdAt,
          event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
            : { pendingTurnStart: true },
        );
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
      }).pipe(
        Effect.andThen(restoreCompaction(event.payload.threadId, true)),
        Effect.catchCause(recoverCompactionFailure),
        Effect.ensuring(Effect.sync(() => void compactingThreadIds.delete(event.payload.threadId))),
        Effect.forkScoped,
      );
      return;
    }
    if (compactingThreadIds.has(event.payload.threadId)) {
      return yield* appendTurnStartFailure(
        "Provider turn start failed",
        "Wait for context compaction to finish before sending another message.",
      );
    }
    // Route this turn to the desired instance's fallback when the desired
    // instance is out of quota. Failure to decide is never fatal: the turn
    // runs unchanged and the provider reports its own error.
    const baseSelection =
      event.payload.modelSelection ??
      threadModelSelections.get(event.payload.threadId) ??
      thread.modelSelection;
    const routed = yield* resolveFallbackSelection({
      selection: baseSelection,
      hasStartedSession: thread.session !== null,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to resolve provider fallback", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (
      routed === undefined &&
      declinedFallbacks.get(event.payload.threadId) === baseSelection.instanceId &&
      (yield* providerRegistry.getProviderUsageLimit(baseSelection.instanceId))?.status !==
        "exhausted"
    ) {
      declinedFallbacks.delete(event.payload.threadId);
    }
    const activeFallback = activeFallbackRoutes.get(event.payload.threadId);
    const approvedFallback =
      activeFallback !== undefined &&
      activeFallback.primarySelection.instanceId === baseSelection.instanceId &&
      activeFallback.primarySelection.model === baseSelection.model
        ? {
            ...activeFallback,
            primarySelection: baseSelection,
            fallbackSelection: {
              ...baseSelection,
              instanceId: activeFallback.fallbackSelection.instanceId,
              model: activeFallback.fallbackSelection.model,
            },
          }
        : undefined;
    if (activeFallback !== undefined && approvedFallback === undefined) {
      activeFallbackRoutes.delete(event.payload.threadId);
    }
    const declinedForPrimary =
      routed !== undefined &&
      declinedFallbacks.get(event.payload.threadId) === routed.primaryInstanceId;
    if (routed !== undefined) {
      const noticeKey = `${event.payload.threadId}:${routed.selection.instanceId}:${routed.selection.model}:${routed.resetsAt ?? "unknown"}`;
      if (
        approvedFallback === undefined &&
        !declinedForPrimary &&
        announcedFallbacks.get(event.payload.threadId) !== noticeKey
      ) {
        // Not yet confirmed for this exhaustion episode: pause this turn and
        // ask, exactly like a mid-turn failure would. A message sent while
        // an earlier offer is still open replaces its pending turn (the
        // user's latest words win) rather than opening a second prompt.
        const threadId = event.payload.threadId;
        const pendingAttempt: PendingTurnAttempt = {
          event,
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          instanceId: baseSelection.instanceId,
          onFallback: false,
          assistantText: "",
          sawWorkItem: false,
        };
        const existingDecision = pendingFallbackDecisions.get(threadId);
        if (existingDecision !== undefined) {
          pendingFallbackDecisions.set(threadId, { ...existingDecision, pending: pendingAttempt });
          return;
        }
        const requestId = yield* serverRequestId();
        pendingFallbackDecisions.set(threadId, {
          requestId,
          pending: pendingAttempt,
          primaryLabel: routed.primaryLabel,
          fallbackLabel: routed.fallbackLabel,
          primaryInstanceId: routed.primaryInstanceId,
        });
        yield* appendFallbackOfferActivity({
          threadId,
          requestId,
          primaryLabel: routed.primaryLabel,
          fallbackLabel: routed.fallbackLabel,
          primaryInstanceId: routed.primaryInstanceId,
          fallbackInstanceId: routed.selection.instanceId,
          model: baseSelection.model,
          modelLabel: routed.modelLabel,
          resetsAt: routed.resetsAt,
          restartsSession: routed.restartsSession,
          usageWindows: routed.usageWindows,
          createdAt: event.payload.createdAt,
        }).pipe(Effect.ignoreCause({ log: true }));
        return;
      }
    }
    const effectiveRoute = declinedForPrimary ? undefined : routed;

    // Track the attempt so a usage-limit failure arriving on the runtime
    // stream can retry once on the fallback. A turn already running on the
    // fallback is not retried again.
    pendingTurnAttempts.set(event.payload.threadId, {
      event,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      instanceId: (effectiveRoute?.selection ?? baseSelection).instanceId,
      onFallback: effectiveRoute !== undefined,
      ...(effectiveRoute === undefined && approvedFallback !== undefined
        ? { returningFromFallback: approvedFallback }
        : {}),
      assistantText: "",
      sawWorkItem: false,
    });

    const turnSelection = effectiveRoute?.selection ?? baseSelection;
    const needsTranscriptHandoff = yield* requiresTranscriptHandoff({
      threadId: event.payload.threadId,
      sessionInstanceId: thread.session?.providerInstanceId,
      desiredInstanceId: turnSelection.instanceId,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to resolve transcript handoff", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

    yield* dispatchTurn({
      event,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      modelSelection: turnSelection,
      requestedModelSelection: baseSelection,
      ...(needsTranscriptHandoff ? { freshProviderHandoff: true } : {}),
    });
  });

  /**
   * Observe the provider runtime stream for usage-limit signals.
   *
   * Two signals matter:
   *   - `account.rate-limits.updated` — the authoritative, structured report.
   *     Normalised and recorded against the emitting instance.
   *   - a turn that fails with a usage-limit message — the only signal Claude
   *     gives when a subscription runs dry mid-turn, because the SDK's
   *     `result` errors reach us as prose (see `resultUserFacingError` in
   *     ClaudeAdapter). Recorded as exhausted with the default cooldown.
   *
   * The second signal offers a fallback before the first retry. An already
   * approved route retries immediately when a return attempt is still exhausted.
   */
  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const instanceId = event.providerInstanceId;
    if (event.type === "account.rate-limits.updated") {
      if (instanceId === undefined) {
        return;
      }
      const usageLimit = providerUsageLimitFromWindows(event.payload.limits);
      if (usageLimit === null) {
        return;
      }
      yield* providerRegistry.setProviderUsageLimit({ instanceId, usageLimit });
      return;
    }

    const pending = pendingTurnAttempts.get(event.threadId);
    if (pending === undefined) {
      return;
    }
    if (instanceId !== pending.instanceId) {
      return;
    }

    // Track what the turn produced. Claude reports an API failure as an
    // assistant message whose text is the error itself, so text alone is not
    // proof of work; it is judged against the failure message below.
    if (event.type === "content.delta") {
      if (event.payload.streamKind === "assistant_text" && pending.assistantText.length < 4000) {
        pending.assistantText += event.payload.delta;
      }
      return;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      if (!PASSIVE_ITEM_TYPES.has(event.payload.itemType)) {
        pending.sawWorkItem = true;
      }
      return;
    }

    if (event.type === "turn.aborted" || event.type === "session.exited") {
      pendingTurnAttempts.delete(event.threadId);
      return;
    }
    if (event.type !== "turn.completed") {
      return;
    }
    pendingTurnAttempts.delete(event.threadId);
    if (event.payload.state !== "failed") {
      declinedFallbacks.delete(event.threadId);
      if (!pending.onFallback) clearAnnouncedFallbacks(event.threadId);
      if (pending.returningFromFallback !== undefined) {
        yield* appendFallbackReturnedActivity({
          threadId: event.threadId,
          primaryLabel: pending.returningFromFallback.primaryLabel,
          primaryInstanceId: pending.returningFromFallback.primarySelection.instanceId,
          fallbackInstanceId: pending.returningFromFallback.fallbackSelection.instanceId,
          model: pending.returningFromFallback.primarySelection.model,
          modelLabel: pending.returningFromFallback.modelLabel,
          createdAt: event.createdAt,
        }).pipe(
          Effect.tap(() => Effect.sync(() => activeFallbackRoutes.delete(event.threadId))),
          Effect.ignoreCause({ log: true }),
        );
      }
      return;
    }
    if (!isUsageLimitFailureMessage(event.payload.errorMessage)) {
      return;
    }

    const nowMs = yield* Clock.currentTimeMillis;
    yield* providerRegistry.setProviderUsageLimit({
      instanceId: pending.instanceId,
      usageLimit: exhaustedUsageLimitFromError({
        nowMs,
        ...(event.payload.errorMessage !== undefined
          ? { message: event.payload.errorMessage }
          : {}),
      }),
    });

    if (
      pending.onFallback ||
      pending.sawWorkItem ||
      hasMeaningfulAssistantText(pending.assistantText, event.payload.errorMessage)
    ) {
      return;
    }
    if (pending.returningFromFallback !== undefined) {
      yield* retryTurnOnFallback(pending);
    } else {
      yield* offerOrContinueFallback(pending);
    }
  });

  /**
   * A turn just failed on usage limit. If this exhaustion episode was
   * already confirmed (the user already said "switch"), keep going quietly
   * on the fallback as before. Otherwise pause and ask, once per episode: a
   * repeat failure while the first offer is still unanswered is dropped
   * rather than piling up a second prompt.
   */
  const offerOrContinueFallback = Effect.fn("offerOrContinueFallback")(function* (
    pending: PendingTurnAttempt,
  ) {
    const threadId = pending.event.payload.threadId;
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return;
    }
    const baseSelection =
      pending.event.payload.modelSelection ??
      threadModelSelections.get(threadId) ??
      thread.modelSelection;
    const routed = yield* resolveFallbackSelection({
      selection: baseSelection,
      hasStartedSession: thread.session !== null,
    });
    if (routed === undefined) {
      return;
    }

    const noticeKey = `${threadId}:${routed.selection.instanceId}:${routed.selection.model}:${routed.resetsAt ?? "unknown"}`;
    if (declinedFallbacks.get(threadId) === routed.primaryInstanceId) {
      return;
    }
    if (announcedFallbacks.get(threadId) === noticeKey) {
      yield* retryTurnOnFallback(pending);
      return;
    }
    if (pendingFallbackDecisions.has(threadId)) {
      return;
    }

    const requestId = yield* serverRequestId();
    pendingFallbackDecisions.set(threadId, {
      requestId,
      pending,
      primaryLabel: routed.primaryLabel,
      fallbackLabel: routed.fallbackLabel,
      primaryInstanceId: routed.primaryInstanceId,
    });
    yield* appendFallbackOfferActivity({
      threadId,
      requestId,
      primaryLabel: routed.primaryLabel,
      fallbackLabel: routed.fallbackLabel,
      primaryInstanceId: routed.primaryInstanceId,
      fallbackInstanceId: routed.selection.instanceId,
      model: baseSelection.model,
      modelLabel: routed.modelLabel,
      resetsAt: routed.resetsAt,
      restartsSession: routed.restartsSession,
      usageWindows: routed.usageWindows,
      createdAt: pending.event.payload.createdAt,
    }).pipe(Effect.ignoreCause({ log: true }));
  });

  const retryTurnOnFallback = Effect.fn("retryTurnOnFallback")(function* (
    pending: PendingTurnAttempt,
    requestId?: ApprovalRequestId,
    activityCreatedAt?: string,
  ) {
    const threadId = pending.event.payload.threadId;
    const approvedRoute = pending.returningFromFallback;
    const thread = approvedRoute === undefined ? yield* resolveThreadShell(threadId) : undefined;
    if (approvedRoute === undefined && thread === undefined) return false;
    const baseSelection =
      approvedRoute?.primarySelection ??
      pending.event.payload.modelSelection ??
      threadModelSelections.get(threadId) ??
      thread?.modelSelection;
    if (baseSelection === undefined) return false;
    const routed =
      approvedRoute !== undefined
        ? {
            selection: approvedRoute.fallbackSelection,
            primaryLabel: approvedRoute.primaryLabel,
            fallbackLabel: approvedRoute.fallbackLabel,
            modelLabel: approvedRoute.modelLabel,
            primaryInstanceId: approvedRoute.primarySelection.instanceId,
            sharesContinuation: approvedRoute.sharesContinuation,
            resetsAt: approvedRoute.resetsAt,
          }
        : yield* resolveFallbackSelection({
            selection: baseSelection,
            hasStartedSession: thread?.session !== null,
          });
    if (routed === undefined) {
      return false;
    }

    const noticeKey = `${threadId}:${routed.selection.instanceId}:${routed.selection.model}:${routed.resetsAt ?? "unknown"}`;
    if (announcedFallbacks.get(threadId) !== noticeKey) {
      announcedFallbacks.set(threadId, noticeKey);
      yield* appendFallbackActivity({
        threadId,
        summary: formatFallbackNotice({
          primaryLabel: routed.primaryLabel,
          fallbackLabel: routed.fallbackLabel,
          modelLabel: routed.modelLabel,
          resetsAt: routed.resetsAt,
        }),
        primaryInstanceId: routed.primaryInstanceId,
        fallbackInstanceId: routed.selection.instanceId,
        model: baseSelection.model,
        modelLabel: routed.modelLabel,
        resetsAt: routed.resetsAt,
        createdAt: activityCreatedAt ?? pending.event.payload.createdAt,
        ...(requestId !== undefined ? { requestId } : {}),
      }).pipe(Effect.ignoreCause({ log: true }));
    }

    activeFallbackRoutes.set(threadId, {
      primarySelection: baseSelection,
      fallbackSelection: routed.selection,
      primaryLabel: routed.primaryLabel,
      fallbackLabel: routed.fallbackLabel,
      modelLabel: routed.modelLabel,
      resetsAt: routed.resetsAt,
      sharesContinuation: routed.sharesContinuation,
    });
    declinedFallbacks.delete(threadId);
    const { returningFromFallback: _returningFromFallback, ...fallbackPending } = pending;
    pendingTurnAttempts.set(threadId, {
      ...fallbackPending,
      instanceId: routed.selection.instanceId,
      onFallback: true,
      assistantText: "",
      sawWorkItem: false,
    });
    yield* dispatchTurn({
      event: pending.event,
      messageText: pending.messageText,
      ...(pending.attachments !== undefined ? { attachments: pending.attachments } : {}),
      modelSelection: routed.selection,
      requestedModelSelection: baseSelection,
      ...(routed.sharesContinuation === false ? { freshProviderHandoff: true } : {}),
    });
    return true;
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processFallbackResponseRequested = Effect.fn("processFallbackResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.fallback-response-requested" }>,
  ) {
    const threadId = event.payload.threadId;
    const decisionEntry = pendingFallbackDecisions.get(threadId);
    if (decisionEntry === undefined || decisionEntry.requestId !== event.payload.requestId) {
      yield* appendFallbackOfferExpiredActivity({
        threadId,
        requestId: event.payload.requestId,
        createdAt: event.payload.createdAt,
      }).pipe(Effect.ignoreCause({ log: true }));
      return;
    }
    pendingFallbackDecisions.delete(threadId);

    if (event.payload.decision === "wait") {
      declinedFallbacks.set(threadId, decisionEntry.primaryInstanceId);
      yield* appendFallbackDeclinedActivity({
        threadId,
        requestId: decisionEntry.requestId,
        primaryLabel: decisionEntry.primaryLabel,
        createdAt: event.payload.createdAt,
      }).pipe(Effect.ignoreCause({ log: true }));
      return;
    }

    const switched = yield* retryTurnOnFallback(
      decisionEntry.pending,
      decisionEntry.requestId,
      event.payload.createdAt,
    );
    if (!switched) {
      yield* appendFallbackOfferExpiredActivity({
        threadId,
        requestId: decisionEntry.requestId,
        createdAt: event.payload.createdAt,
      }).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    const wasCompacting = compactingThreadIds.has(thread.id);
    stoppingThreadIds.add(thread.id);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
    yield* (
      thread.session && thread.session.status !== "stopped"
        ? providerService.stopSession({ threadId: thread.id })
        : Effect.void
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail = formatFailureDetail(cause);
          return Effect.sync(() => {
            stoppingThreadIds.delete(thread.id);
            return wasCompacting && !compactingThreadIds.has(thread.id);
          }).pipe(
            Effect.flatMap((compactionSettled) =>
              compactionSettled ? restoreCompaction(thread.id) : Effect.void,
            ),
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: thread.id,
                kind: "provider.session.stop.failed",
                summary: "Provider session stop failed",
                detail,
                turnId: null,
                createdAt: now,
              }),
            ),
          );
        },
        onSuccess: () =>
          setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "stopped",
              providerName: thread.session?.providerName ?? null,
              ...(thread.session?.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: thread.session?.lastError ?? null,
              updatedAt: now,
            },
            createdAt: now,
          }),
      }),
      Effect.ensuring(clearStopping),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection =
          activeFallbackRoutes.get(event.payload.threadId)?.fallbackSelection ??
          threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.fallback-response-requested":
        yield* processFallbackResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.session == null ||
          thread.value.session.status === "stopped"
        ) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.fallback-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        processRuntimeEvent(event).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "provider command reactor failed to process provider runtime event",
                  { eventType: event.type, cause: Cause.pretty(cause) },
                ),
          ),
        ),
      ),
    );

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProviderSessionRuntime.layer),
);
