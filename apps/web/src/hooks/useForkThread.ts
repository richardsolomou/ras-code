import { scopeProjectRef } from "@ras-code/client-runtime/environment";
import type { MessageId, ThreadForkWorkspaceMode, ThreadId } from "@ras-code/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { newDraftId, newThreadId } from "../lib/utils";
import { useProjects } from "../state/entities";
import type { Thread } from "../types";
import { useClientSettings } from "./useSettings";

export interface ForkThreadRequest {
  /** The thread being forked. */
  readonly sourceThread: Thread;
  /** The user message the fork is cut *before*. */
  readonly messageId: MessageId;
  /** The source thread's checkpoint turn count at that point. */
  readonly turnCount: number;
  /** That message's text, pre-filled into the fork's composer. */
  readonly promptSeed: string;
  readonly workspaceMode: ThreadForkWorkspaceMode;
}

/**
 * Opens a fork of a thread as a draft.
 *
 * The fork is not created on the server yet: the draft holds the fork point,
 * the composer holds the message to re-ask, and sending is what cuts the fork.
 * That keeps "fork" and "say something different" one gesture, and leaves an
 * abandoned fork as a draft the user can simply discard.
 */
export function useForkThreadHandler() {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();

  return useCallback(
    async (
      request: ForkThreadRequest,
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const { sourceThread } = request;
      const project = projects.find(
        (candidate) =>
          candidate.id === sourceThread.projectId &&
          candidate.environmentId === sourceThread.environmentId,
      );
      if (!project) {
        return null;
      }

      const projectRef = scopeProjectRef(sourceThread.environmentId, sourceThread.projectId);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        project,
        projectGroupingSettings,
      );
      const { setLogicalProjectDraftThreadId, setModelSelection, setPrompt } =
        useComposerDraftStore.getState();

      const draftId = newDraftId();
      const threadId = newThreadId();
      // Forking in place means running where the parent runs; a worktree fork
      // gets its own, cut from the parent's branch by the server.
      const forksInPlace = request.workspaceMode === "in-place";

      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt: new Date().toISOString(),
        branch: sourceThread.branch,
        worktreePath: forksInPlace ? sourceThread.worktreePath : null,
        envMode: forksInPlace ? (sourceThread.worktreePath ? "worktree" : "local") : "worktree",
        // A fork branches from the parent's work, never from origin.
        startFromOrigin: false,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        forkedFrom: {
          threadId: sourceThread.id,
          messageId: request.messageId,
          turnCount: request.turnCount,
          workspaceMode: request.workspaceMode,
          sourceTitle: sourceThread.title,
        },
      });
      // The fork inherits the parent's model so "same route, different words"
      // is the default; the composer's model picker is how you change it.
      setModelSelection(draftId, sourceThread.modelSelection, { replaceOptions: true });
      setPrompt(draftId, request.promptSeed);

      await router.navigate({ to: "/draft/$draftId", params: { draftId } });
      return { draftId, threadId };
    },
    [projectGroupingSettings, projects, router],
  );
}
