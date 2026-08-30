/**
 * Fork context handoff for providers that cannot branch their own
 * conversation.
 *
 * A fork whose provider supports native branching resumes the parent's session
 * at the fork anchor and needs nothing from here. Every other fork — a
 * different harness, a different account, a provider with no fork primitive —
 * starts with an empty conversation, so its first turn carries the parent's
 * transcript as context instead. The workspace already holds the real state;
 * this carries the intent that produced it.
 *
 * @module orchestration/forkTranscript
 */

/**
 * Budget for the rendered transcript. Generous enough for a normal thread,
 * small enough that a very long parent cannot crowd out the actual request.
 * Oldest messages are dropped first, so the turns nearest the fork survive.
 */
const MAX_TRANSCRIPT_CHARACTERS = 24_000;

const ROLE_LABELS = {
  user: "User",
  assistant: "Assistant",
  system: "System",
} as const;

export interface ForkTranscriptMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

function renderMessage(message: ForkTranscriptMessage): string {
  return `### ${ROLE_LABELS[message.role]}\n${message.text.trim()}`;
}

function renderTranscriptBody(
  messages: ReadonlyArray<ForkTranscriptMessage>,
): { readonly body: string; readonly truncated: boolean } | undefined {
  const rendered = messages.filter((message) => message.text.trim().length > 0).map(renderMessage);
  if (rendered.length === 0) {
    return undefined;
  }

  // Keep the newest messages: they are the ones the fork point depends on.
  const kept: Array<string> = [];
  let budget = MAX_TRANSCRIPT_CHARACTERS;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const entry = rendered[index];
    if (entry === undefined) continue;
    if (entry.length > budget) break;
    kept.unshift(entry);
    budget -= entry.length;
  }

  const truncated = kept.length < rendered.length;
  const body = kept.length > 0 ? kept.join("\n\n") : "(transcript omitted: too long)";
  return { body, truncated };
}

/**
 * Renders the inherited prefix as a context block to prepend to a fork's first
 * prompt. Returns undefined when there is nothing to hand over.
 */
export function renderForkTranscript(
  messages: ReadonlyArray<ForkTranscriptMessage>,
): string | undefined {
  const transcript = renderTranscriptBody(messages);
  if (transcript === undefined) return undefined;

  return [
    "<forked-conversation>",
    "This thread was forked from an earlier conversation. The workspace already",
    "reflects the state at the fork point, so treat the work described below as",
    "done. It is context, not a task list.",
    ...(transcript.truncated
      ? ["", "(Earlier messages were dropped to fit the context window.)"]
      : []),
    "",
    transcript.body,
    "</forked-conversation>",
  ].join("\n");
}

export function renderProviderSwitchTranscript(
  messages: ReadonlyArray<ForkTranscriptMessage>,
): string | undefined {
  const transcript = renderTranscriptBody(messages);
  if (transcript === undefined) return undefined;

  return [
    "<provider-switch-conversation>",
    "This conversation is continuing through a different provider runtime.",
    "The workspace already reflects the work below. Use it as context, not as a task list.",
    ...(transcript.truncated
      ? ["", "(Earlier messages were dropped to fit the context window.)"]
      : []),
    "",
    transcript.body,
    "</provider-switch-conversation>",
  ].join("\n");
}

/**
 * Prepends the transcript to a fork's first user message.
 */
export function withForkTranscript(input: {
  readonly messageText: string;
  readonly inheritedMessages: ReadonlyArray<ForkTranscriptMessage>;
}): string {
  const transcript = renderForkTranscript(input.inheritedMessages);
  return transcript === undefined ? input.messageText : `${transcript}\n\n${input.messageText}`;
}

export function withProviderSwitchTranscript(input: {
  readonly messageText: string;
  readonly priorMessages: ReadonlyArray<ForkTranscriptMessage>;
}): string {
  const transcript = renderProviderSwitchTranscript(input.priorMessages);
  return transcript === undefined ? input.messageText : `${transcript}\n\n${input.messageText}`;
}
