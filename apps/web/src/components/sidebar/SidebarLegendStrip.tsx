import { memo } from "react";

import { StatusGlyph, StatusLamp, type LampState } from "../StatusLamp";

const ENTRIES: ReadonlyArray<{ state: LampState; word: string }> = [
  { state: "working", word: "working" },
  { state: "waiting", word: "waiting" },
  { state: "failed", word: "failed" },
  { state: "idle", word: "idle" },
];

/**
 * The console's key: what each lamp means, and how many stations are lit
 * right now. Fixed above the utility row, hidden when the rail collapses to
 * icons.
 */
export const SidebarLegendStrip = memo(function SidebarLegendStrip({
  workingCount,
  waitingCount,
}: {
  workingCount: number;
  waitingCount: number;
}) {
  return (
    <div
      data-testid="sidebar-legend-strip"
      className="legend flex items-center justify-between gap-1 overflow-hidden border-[var(--console-rule)] border-t -mx-[var(--sidebar-content-inset)] px-1.5 pt-2 pb-1 text-[9px] text-muted-foreground tracking-[0.02em] group-data-[collapsible=icon]:hidden"
    >
      {ENTRIES.map((entry) => (
        <span key={entry.state} className="inline-flex shrink-0 items-center gap-0.5">
          <StatusLamp state={entry.state} size={8} />
          <StatusGlyph state={entry.state} className="size-2" />
          <span>
            {entry.state === "working"
              ? `${workingCount} ${entry.word}`
              : entry.state === "waiting"
                ? `${waitingCount} ${entry.word}`
                : entry.word}
          </span>
        </span>
      ))}
    </div>
  );
});
