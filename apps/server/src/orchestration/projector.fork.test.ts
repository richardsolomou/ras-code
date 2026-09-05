import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { assert, expect, it } from "@effect/vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-03-01T00:00:00.000Z";
const MODEL_SELECTION = { instanceId: "claude", model: "claude-opus-5" };

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  aggregateId: string;
  payload: unknown;
  occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const applyAll = (events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let model: OrchestrationReadModel = createEmptyReadModel(NOW);
    for (const event of events) {
      model = yield* projectEvent(model, event);
    }
    return model;
  });

const forkedEvent = makeEvent({
  sequence: 1,
  type: "thread.forked",
  aggregateId: "thread-fork",
  payload: {
    threadId: "thread-fork",
    projectId: ProjectId.make("project-1"),
    sourceThreadId: "thread-parent",
    sourceMessageId: "message-3",
    turnCount: 2,
    title: "Fork of parent",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "ras/parent",
    worktreePath: "/tmp/fork",
    inheritedMessages: [
      { messageId: "inherited-1", role: "user", text: "first ask", createdAt: NOW },
      { messageId: "inherited-2", role: "assistant", text: "first answer", createdAt: NOW },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.layer(NodeServices.layer)("orchestration projector thread.forked", (it) => {
  it.effect("creates the fork with its fork point and inherited history", () =>
    Effect.gen(function* () {
      const model = yield* applyAll([forkedEvent]);
      const thread = model.threads.find((entry) => entry.id === "thread-fork");
      assert.isDefined(thread);
      expect(thread?.forkedFrom).toEqual({
        threadId: "thread-parent",
        messageId: "message-3",
        turnCount: 2,
      });
      expect(thread?.branch).toBe("ras/parent");
      expect(thread?.worktreePath).toBe("/tmp/fork");
      expect(
        thread?.messages.map((message) => [message.text, message.inherited, message.turnId]),
      ).toEqual([
        ["first ask", true, null],
        ["first answer", true, null],
      ]);
    }),
  );

  it.effect("keeps inherited history when the fork reverts its own turns", () =>
    Effect.gen(function* () {
      const model = yield* applyAll([
        forkedEvent,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateId: "thread-fork",
          occurredAt: "2026-03-01T00:01:00.000Z",
          payload: {
            threadId: "thread-fork",
            messageId: "own-user",
            role: "user",
            text: "different route",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2026-03-01T00:01:00.000Z",
            updatedAt: "2026-03-01T00:01:00.000Z",
          },
        }),
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateId: "thread-fork",
          occurredAt: "2026-03-01T00:01:01.000Z",
          payload: {
            threadId: "thread-fork",
            messageId: "own-assistant",
            role: "assistant",
            text: "did the different thing",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2026-03-01T00:01:01.000Z",
            updatedAt: "2026-03-01T00:01:01.000Z",
          },
        }),
        makeEvent({
          sequence: 4,
          type: "thread.reverted",
          aggregateId: "thread-fork",
          occurredAt: "2026-03-01T00:02:00.000Z",
          payload: {
            threadId: "thread-fork",
            turnCount: 0,
            revertedAt: "2026-03-01T00:02:00.000Z",
            updatedAt: "2026-03-01T00:02:00.000Z",
          },
        }),
      ]);

      const thread = model.threads.find((entry) => entry.id === "thread-fork");
      // The fork's own turn is gone; the parent's history it was cut from is not
      // this thread's to undo.
      expect(thread?.messages.map((message) => message.id)).toEqual(["inherited-1", "inherited-2"]);
    }),
  );
});
