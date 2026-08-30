import { scopeProjectRef } from "@ras-code/client-runtime/environment";
import type { MessageId, ThreadId } from "@ras-code/contracts";
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
  /** The assistant response included at the end of the fork's inherited history. */
  readonly messageId: MessageId;
  /** The source thread's checkpoint turn count after that response. */
  readonly turnCount: number;
}

/**
 * Opens a fork of a thread as a draft.
 *
 * The fork is created on the server when its first message is sent. Until then,
 * the draft renders the parent's inherited prefix and an empty composer.
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
      const { setLogicalProjectDraftThreadId, setModelSelection } =
        useComposerDraftStore.getState();

      const draftId = newDraftId();
      const threadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt: new Date().toISOString(),
        branch: sourceThread.branch,
        worktreePath: null,
        envMode: "worktree",
        // A fork branches from the parent's work, never from origin.
        startFromOrigin: false,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        forkedFrom: {
          threadId: sourceThread.id,
          messageId: request.messageId,
          turnCount: request.turnCount,
          workspaceMode: "worktree",
          sourceTitle: sourceThread.title,
        },
      });
      // The fork inherits the parent's model so "same route, different words"
      // is the default; the composer's model picker is how you change it.
      setModelSelection(draftId, sourceThread.modelSelection, { replaceOptions: true });

      await router.navigate({ to: "/draft/$draftId", params: { draftId } });
      return { draftId, threadId };
    },
    [projectGroupingSettings, projects, router],
  );
}
