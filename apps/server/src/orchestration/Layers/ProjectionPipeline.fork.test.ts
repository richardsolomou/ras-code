import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadForkPoint,
  ThreadId,
  TurnId,
} from "@ras-code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "ras-code-projection-fork-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const decodeForkPoint = Schema.decodeSync(Schema.fromJsonString(ThreadForkPoint));

const NOW = "2026-03-01T00:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

it.layer(TestLayer)("OrchestrationProjectionPipeline forking", (it) => {
  it.effect("projects a fork's thread row, fork point, and inherited messages", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-project"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      });

      yield* eventStore.append({
        type: "thread.forked",
        eventId: EventId.make("evt-fork"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-fork"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-fork"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-fork"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-fork"),
          projectId: ProjectId.make("project-1"),
          sourceThreadId: ThreadId.make("thread-parent"),
          sourceMessageId: MessageId.make("message-3"),
          turnCount: NonNegativeInt.make(2),
          title: "Fork of parent",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: "ras/parent",
          worktreePath: "/tmp/fork",
          inheritedMessages: [
            {
              messageId: MessageId.make("inherited-1"),
              role: "user",
              text: "first ask",
              createdAt: NOW,
            },
            {
              messageId: MessageId.make("inherited-2"),
              role: "assistant",
              text: "first answer",
              createdAt: NOW,
            },
          ],
          createdAt: NOW,
          updatedAt: NOW,
        },
      });

      yield* projectionPipeline.bootstrap;

      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly branch: string | null;
        readonly forkedFrom: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          branch,
          forked_from_json AS "forkedFrom"
        FROM projection_threads
      `;
      assert.equal(threadRows.length, 1);
      assert.equal(threadRows[0]?.branch, "ras/parent");
      assert.deepEqual(decodeForkPoint(threadRows[0]?.forkedFrom ?? ""), {
        threadId: "thread-parent",
        messageId: "message-3",
        turnCount: 2,
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
        readonly inherited: number;
        readonly turnId: string | null;
      }>`
        SELECT
          message_id AS "messageId",
          text,
          inherited,
          turn_id AS "turnId"
        FROM projection_thread_messages
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        { messageId: "inherited-1", text: "first ask", inherited: 1, turnId: null },
        { messageId: "inherited-2", text: "first answer", inherited: 1, turnId: null },
      ]);
    }),
  );

  it.effect("keeps a turn's resume anchor when a later event rewrites the turn row", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.turn-resume-anchor-set",
        eventId: EventId.make("evt-anchor"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-anchor"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-anchor"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-anchor"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-anchor"),
          turnId: TurnId.make("turn-1"),
          resumeAnchor: "11111111-2222-3333-4444-555555555555",
          createdAt: NOW,
        },
      });

      // No turn row yet: the anchor has nothing to stamp and must not create one.
      yield* projectionPipeline.bootstrap;
      const emptyRows = yield* sql<{ readonly resumeAnchor: string | null }>`
        SELECT resume_anchor AS "resumeAnchor" FROM projection_turns
        WHERE thread_id = 'thread-anchor'
      `;
      assert.equal(emptyRows.length, 0);

      yield* eventStore.append({
        type: "thread.turn-interrupt-requested",
        eventId: EventId.make("evt-turn"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-anchor"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-turn"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-turn"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-anchor"),
          turnId: TurnId.make("turn-1"),
          createdAt: NOW,
        },
      });
      yield* eventStore.append({
        type: "thread.turn-resume-anchor-set",
        eventId: EventId.make("evt-anchor-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-anchor"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-anchor-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-anchor-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-anchor"),
          turnId: TurnId.make("turn-1"),
          resumeAnchor: "11111111-2222-3333-4444-555555555555",
          createdAt: NOW,
        },
      });
      // A checkpoint landing after the anchor rewrites the whole turn row.
      yield* eventStore.append({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-diff"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-anchor"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-diff"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-diff"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-anchor"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: NonNegativeInt.make(1),
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-anchor/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: NOW,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly resumeAnchor: string | null;
        readonly checkpointTurnCount: number | null;
      }>`
        SELECT
          resume_anchor AS "resumeAnchor",
          checkpoint_turn_count AS "checkpointTurnCount"
        FROM projection_turns
        WHERE thread_id = 'thread-anchor'
      `;
      assert.deepEqual(rows, [
        {
          resumeAnchor: "11111111-2222-3333-4444-555555555555",
          checkpointTurnCount: 1,
        },
      ]);
    }),
  );
});
