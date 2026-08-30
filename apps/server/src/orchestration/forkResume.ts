/**
 * Whether a fork can become a real branch of its parent's provider
 * conversation, and the resume cursor that does it.
 *
 * Kept pure and separate from the reactor that fetches its inputs: the answer
 * must depend only on persisted state, so a fork decides the same way before
 * and after a server restart.
 *
 * @module orchestration/forkResume
 */

export interface ForkResumeInput {
  /** Where the fork was cut, or null when this thread is not a fork. */
  readonly forkedFrom: { readonly turnCount: number } | null;
  /** The parent thread's persisted provider resume cursor. */
  readonly parentResumeCursor: unknown;
  /**
   * Continuation keys for the parent's provider instance and the one the fork
   * is about to start on. Only a provider that can read the parent's session
   * can branch it — the same compatibility test a mid-thread instance switch
   * uses.
   */
  readonly parentContinuationKey: string | undefined;
  readonly desiredContinuationKey: string | undefined;
  /** The parent's turn projection rows, in any order. */
  readonly parentTurns: ReadonlyArray<{
    readonly checkpointTurnCount: number | null;
    readonly resumeAnchor: string | null;
  }>;
}

/**
 * The resume cursor for a forked thread's first session, or undefined when the
 * fork has to fall back to a transcript handoff.
 *
 * The parent's cursor is passed through opaquely with one field added: only
 * the adapter that wrote the cursor knows how to read the rest of it.
 */
export function resolveForkResumeCursor(
  input: ForkResumeInput,
): Record<string, unknown> | undefined {
  const forkedFrom = input.forkedFrom;
  // Forking before the parent's first turn inherits no provider context.
  if (forkedFrom === null || forkedFrom.turnCount === 0) {
    return undefined;
  }
  if (
    input.parentResumeCursor === null ||
    typeof input.parentResumeCursor !== "object" ||
    Array.isArray(input.parentResumeCursor)
  ) {
    return undefined;
  }
  if (
    input.parentContinuationKey === undefined ||
    input.desiredContinuationKey === undefined ||
    input.parentContinuationKey !== input.desiredContinuationKey
  ) {
    return undefined;
  }

  const anchor = input.parentTurns.find(
    (turn) => turn.checkpointTurnCount === forkedFrom.turnCount,
  )?.resumeAnchor;
  if (anchor === null || anchor === undefined || anchor.length === 0) {
    return undefined;
  }

  return { ...(input.parentResumeCursor as Record<string, unknown>), forkAtAnchor: anchor };
}
