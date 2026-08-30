import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadForkedPayload,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ras-code/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
} as const;

const projectCreated = (projectId: string, sequence: number): OrchestrationEvent =>
  ({
    sequence,
    eventId: asEventId(`evt-project-${projectId}`),
    aggregateKind: "project",
    aggregateId: asProjectId(projectId),
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId(`cmd-project-${projectId}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-project-${projectId}`),
    metadata: {},
    payload: {
      projectId: asProjectId(projectId),
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  }) as OrchestrationEvent;

const threadCreated = (threadId: string, projectId: string, sequence: number): OrchestrationEvent =>
  ({
    sequence,
    eventId: asEventId(`evt-thread-${threadId}`),
    aggregateKind: "thread",
    aggregateId: asThreadId(threadId),
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId(`cmd-thread-${threadId}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-thread-${threadId}`),
    metadata: {},
    payload: {
      threadId: asThreadId(threadId),
      projectId: asProjectId(projectId),
      title: threadId,
      modelSelection: MODEL_SELECTION,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  }) as OrchestrationEvent;

const seedReadModel = Effect.gen(function* () {
  let readModel: OrchestrationReadModel = createEmptyReadModel(NOW);
  const events = [
    projectCreated("project-a", 1),
    projectCreated("project-b", 2),
    threadCreated("thread-parent", "project-a", 3),
    threadCreated("thread-elsewhere", "project-b", 4),
  ];
  for (const event of events) {
    readModel = yield* projectEvent(readModel, event);
  }
  return readModel;
});

const forkCommand = (overrides?: {
  readonly projectId?: string;
  readonly sourceThreadId?: string;
}) =>
  ({
    type: "thread.fork",
    commandId: asCommandId("cmd-fork"),
    threadId: asThreadId("thread-fork"),
    projectId: asProjectId(overrides?.projectId ?? "project-a"),
    sourceThreadId: asThreadId(overrides?.sourceThreadId ?? "thread-parent"),
    sourceMessageId: asMessageId("message-3"),
    turnCount: NonNegativeInt.make(2),
    title: "Fork of thread-parent",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "ras/parent",
    worktreePath: null,
    inheritedMessages: [
      {
        messageId: asMessageId("fork-message-1"),
        role: "user",
        text: "first ask",
        createdAt: NOW,
      },
      {
        messageId: asMessageId("fork-message-2"),
        role: "assistant",
        text: "first answer",
        createdAt: NOW,
      },
    ],
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("decider thread.fork", (it) => {
  it.effect("emits thread.forked carrying the fork point and inherited prefix", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const event = yield* decideOrchestrationCommand({ readModel, command: forkCommand() });

      assert.isFalse(Array.isArray(event));
      // `Omit` over the event union collapses the discriminant, so narrow by
      // the shape this case is asserted to produce.
      const forked = event as {
        readonly type: string;
        readonly aggregateId: string;
        readonly payload: typeof ThreadForkedPayload.Type;
      };
      expect(forked.type).toBe("thread.forked");
      expect(forked.aggregateId).toBe(asThreadId("thread-fork"));
      expect(forked.payload.sourceThreadId).toBe(asThreadId("thread-parent"));
      expect(forked.payload.sourceMessageId).toBe(asMessageId("message-3"));
      expect(forked.payload.turnCount).toBe(2);
      expect(forked.payload.branch).toBe("ras/parent");
      expect(forked.payload.inheritedMessages.map((message) => message.text)).toEqual([
        "first ask",
        "first answer",
      ]);
    }),
  );

  it.effect("rejects forking a thread that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: forkCommand({ sourceThreadId: "thread-missing" }),
        }),
      );
      assert.include(error.message, "thread-missing");
    }),
  );

  it.effect("rejects forking across projects", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: forkCommand({ sourceThreadId: "thread-elsewhere" }),
        }),
      );
      assert.include(error.message, "project-b");
    }),
  );

  it.effect("rejects forking onto a live thread id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: { ...forkCommand(), threadId: asThreadId("thread-parent") },
        }),
      );
      assert.include(error.message, "cannot be created twice");
    }),
  );
});
