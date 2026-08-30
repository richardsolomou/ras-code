export function selectForkInheritedPrefix<
  Message extends { readonly id: string; readonly createdAt: string; readonly streaming: boolean },
>(messages: ReadonlyArray<Message>, sourceMessageId: string): Message[] | null {
  const orderedMessages = messages.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const forkIndex = orderedMessages.findIndex((message) => message.id === sourceMessageId);
  if (forkIndex < 0) return null;
  return orderedMessages.slice(0, forkIndex + 1).filter((message) => !message.streaming);
}
