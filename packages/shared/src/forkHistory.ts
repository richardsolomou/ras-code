import type { ThreadForkMessageBoundary } from "@ras-code/contracts";

export function selectForkInheritedPrefix<
  Message extends { readonly id: string; readonly createdAt: string; readonly streaming: boolean },
>(
  messages: ReadonlyArray<Message>,
  sourceMessageId: string,
  sourceMessageBoundary: ThreadForkMessageBoundary = "before",
): Message[] | null {
  const orderedMessages = messages.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const forkIndex = orderedMessages.findIndex((message) => message.id === sourceMessageId);
  if (forkIndex < 0) return null;
  const prefixEnd = sourceMessageBoundary === "after" ? forkIndex + 1 : forkIndex;
  return orderedMessages.slice(0, prefixEnd).filter((message) => !message.streaming);
}
