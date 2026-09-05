import type { ThreadForkMessageBoundary } from "@t3tools/contracts";

export function resolveForkTurnCount<
  Message extends { readonly id: string; readonly role: string; readonly streaming: boolean },
  Checkpoint extends {
    readonly assistantMessageId: string | null;
    readonly checkpointTurnCount: number;
  },
>(
  messages: ReadonlyArray<Message>,
  checkpoints: ReadonlyArray<Checkpoint>,
  sourceMessageId: string,
  sourceMessageBoundary: ThreadForkMessageBoundary,
  requestedTurnCount: number,
): number | null {
  if (sourceMessageBoundary === "before") return requestedTurnCount;
  const sourceMessage = messages.find((message) => message.id === sourceMessageId);
  if (sourceMessage?.role !== "assistant" || sourceMessage.streaming) return null;
  return (
    checkpoints.find((checkpoint) => checkpoint.assistantMessageId === sourceMessageId)
      ?.checkpointTurnCount ?? null
  );
}
