import type { EnvironmentThreadShell } from "@ras-code/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationThreadShell } from "@ras-code/contracts";
import {
  createLinkedPullRequestDetailAtomFamily,
  pullRequestDetailToVcsStatus,
  resolveThreadPullRequestRef,
} from "@ras-code/client-runtime/state/pull-requests";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

const linkedPullRequestDetailAtom = createLinkedPullRequestDetailAtomFamily(connectionAtomRuntime);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

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
 * Detail for the pull request the thread shows: its linked record when a turn wrote one, and
 * otherwise the open pull request on its branch, which is the only thing a pull request opened
 * outside a turn ever has. The branch lookup needs the project's repository to address the read,
 * so a project without one leaves the thread on its linked record alone.
 */
export function useThreadPullRequestDetail(
  thread: Pick<OrchestrationThreadShell, "projectId" | "branch" | "linkedPullRequest">,
  environmentId: EnvironmentId,
  project: { readonly cwd: string | null; readonly repository: string | null },
) {
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null && thread.branch !== null && project.cwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: project.cwd } })
      : null,
  ).data;
  const ref = resolveThreadPullRequestRef({
    linkedPullRequest: thread.linkedPullRequest,
    projectId: thread.projectId,
    repository: project.repository,
    branchPullRequest: gitStatus?.refName === thread.branch ? gitStatus.pr : null,
  });
  return useEnvironmentQuery(
    ref === null ? null : linkedPullRequestDetailAtom({ environmentId, input: ref }),
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
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null && thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  const linkedPullRequest = useLinkedPullRequestDetail(thread, thread.environmentId);

  if (thread.linkedPullRequest != null) {
    const detail = linkedPullRequest;
    return detail === null
      ? null
      : presentThreadPr(pullRequestDetailToVcsStatus(detail), {
          kind: detail.provider,
          name: detail.provider,
          baseUrl: "",
        });
  }

  const status = gitStatus.data;
  if (status === null || thread.branch === null || status.refName !== thread.branch) {
    return null;
  }
  if (!status.pr) {
    return null;
  }
  return presentThreadPr(status.pr, status.sourceControlProvider);
}
