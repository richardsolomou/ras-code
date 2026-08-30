import { scopeThreadRef } from "@ras-code/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@ras-code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { memo } from "react";

import { useThreadForks, useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ThreadForkLineageProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Both directions of a fork relationship, in the header.
 *
 * A fork shows where it came from, and the thread it came from shows what came
 * out of it — otherwise a fork is a one-way door: you take it and lose track
 * of the thread you left.
 */
export const ThreadForkLineage = memo(function ThreadForkLineage({
  environmentId,
  threadId,
}: ThreadForkLineageProps) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(threadRef);
  const forkedFrom = shell?.forkedFrom ?? null;
  const parent = useThreadShell(
    forkedFrom ? scopeThreadRef(environmentId, forkedFrom.threadId) : null,
  );
  const forks = useThreadForks(threadRef);

  const goToThread = (targetThreadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: targetThreadId },
    });

  if (forkedFrom === null && forks.length === 0) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {forkedFrom !== null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="gap-1 text-muted-foreground"
                onClick={() => goToThread(forkedFrom.threadId)}
                // The parent may live on a server this client has not loaded
                // shells for yet; the label degrades, the link still works.
                aria-label={`Go to the thread this was forked from${parent ? `: ${parent.title}` : ""}`}
              >
                <GitForkIcon className="size-3" />
                <span className="max-w-32 truncate">{parent?.title ?? "Forked from"}</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {parent ? `Forked from ${parent.title}` : "Forked from another thread"}
          </TooltipPopup>
        </Tooltip>
      )}
      {forks.length > 0 && (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="gap-1 text-muted-foreground"
                      aria-label={`${forks.length} fork${forks.length === 1 ? "" : "s"} of this thread`}
                    >
                      <GitForkIcon className="size-3" />
                      <span>{forks.length}</span>
                    </Button>
                  }
                />
              }
            />
            <TooltipPopup side="bottom">
              {forks.length === 1
                ? "1 fork of this thread"
                : `${forks.length} forks of this thread`}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="start">
            {forks.map((fork) => (
              <MenuItem key={fork.threadId} onClick={() => goToThread(fork.threadId)}>
                {fork.title}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
});
