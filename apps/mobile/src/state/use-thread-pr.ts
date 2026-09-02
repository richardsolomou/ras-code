import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@ras-code/client-runtime/environment";
import type { EnvironmentThreadShell } from "@ras-code/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationThreadShell } from "@ras-code/contracts";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@ras-code/client-runtime/state/pull-requests";
import { createEnvironmentRpcQueryAtomFamily } from "@ras-code/client-runtime/state/runtime";
import { WS_METHODS } from "@ras-code/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

const linkedPullRequestDetailAtom = createLinkedPullRequestSummaryAtomFamily(connectionAtomRuntime);
// The summary omits mergeability, so the open thread reads the full detail for
// its own linked pull request rather than for every row in the list.
const linkedPullRequestFullDetailAtom = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-data:pull-requests:detail",
  tag: WS_METHODS.pullRequestsDetail,
  staleTimeMs: 15_000,
});
const MAX_THREAD_PR_SNAPSHOTS = 500;

interface ThreadPrSnapshot {
  readonly identity: string;
  readonly presentation: ThreadPrPresentation;
}

// One bounded cache survives row virtualization without retaining one live
// atom for every thread, branch, directory, or linked pull request ever seen.
const threadPrSnapshotsAtom = Atom.make<ReadonlyMap<string, ThreadPrSnapshot>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/** Full detail, including mergeability, for the open thread's linked pull request. */
export function useLinkedPullRequestFullDetail(
  thread: Pick<OrchestrationThreadShell, "linkedPullRequest">,
  environmentId: EnvironmentId,
) {
  return useEnvironmentQuery(
    thread.linkedPullRequest == null
      ? null
      : linkedPullRequestFullDetailAtom({
          environmentId,
          input: {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
        }),
  ).data;
}

export function useLinkedPullRequestDetail(
  thread: Pick<OrchestrationThreadShell, "linkedPullRequest">,
  environmentId: EnvironmentId,
) {
  return useEnvironmentQuery(
    thread.linkedPullRequest == null
      ? null
      : linkedPullRequestDetailAtom({
          environmentId,
          input: {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
        }),
  ).data;
}

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so many rows on the same worktree
 * or project root share one stream — and virtualization means only visible
 * rows subscribe at all.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const snapshotIdentity = JSON.stringify(
    thread.linkedPullRequest ?? { branch: thread.branch, cwd },
  );
  // Select this row's entry so writes for other rows do not re-render it.
  const snapshotEntry = useAtomValue(
    threadPrSnapshotsAtom,
    useCallback(
      (current: ReadonlyMap<string, ThreadPrSnapshot>) => current.get(threadKey),
      [threadKey],
    ),
  );
  const snapshot = snapshotEntry?.identity === snapshotIdentity ? snapshotEntry.presentation : null;
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null && thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  const linkedPullRequest = useLinkedPullRequestDetail(thread, thread.environmentId);

  const live = useMemo<ThreadPrPresentation | null | undefined>(() => {
    if (thread.linkedPullRequest != null) {
      const detail = linkedPullRequest;
      return detail === null
        ? undefined
        : presentThreadPr(pullRequestDetailToVcsStatus(detail), {
            kind: detail.provider,
            name: detail.provider,
            baseUrl: "",
          });
    }

    const status = gitStatus.data;
    if (thread.branch === null) return null;
    if (status === null) return undefined;
    if (status.refName !== thread.branch || !status.pr) return null;
    return presentThreadPr(status.pr, status.sourceControlProvider);
  }, [gitStatus.data, linkedPullRequest, thread.branch, thread.linkedPullRequest]);

  useEffect(() => {
    if (live === undefined) return;
    appAtomRegistry.modify(threadPrSnapshotsAtom, (current) => {
      const existing = current.get(threadKey);
      if (live === null) {
        if (existing === undefined) return [false, current];
        const next = new Map(current);
        next.delete(threadKey);
        return [true, next];
      }
      if (existing?.identity === snapshotIdentity && existing.presentation === live) {
        return [false, current];
      }
      const next = new Map(current);
      next.delete(threadKey);
      next.set(threadKey, { identity: snapshotIdentity, presentation: live });
      while (next.size > MAX_THREAD_PR_SNAPSHOTS) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return [true, next];
    });
  }, [live, snapshotIdentity, threadKey]);

  return live === undefined ? snapshot : live;
}
