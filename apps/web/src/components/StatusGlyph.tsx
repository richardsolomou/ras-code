import type { LucideIcon } from "lucide-react";
import { CheckIcon, CircleDashedIcon, FlagIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Console state channel. The glyph carries the state and the caller's label
 * repeats it, so a status stays readable without colour.
 *
 * `idle` is a station at rest — nothing running, nothing waiting on the user —
 * and draws no glyph; the row's timestamp is the whole story. `settled` is the
 * separate, explicit "done, not archived" state and shows the check.
 */
export type StatusState = "working" | "waiting" | "failed" | "settled" | "idle";

const STATUS_GLYPHS: Partial<Record<StatusState, LucideIcon>> = {
  working: CircleDashedIcon,
  waiting: FlagIcon,
  failed: XIcon,
  settled: CheckIcon,
};

export function StatusGlyph({
  state,
  pulse = false,
  className,
}: {
  state: StatusState;
  pulse?: boolean;
  className?: string | undefined;
}) {
  const Glyph = STATUS_GLYPHS[state];
  if (Glyph === undefined) {
    return null;
  }
  return (
    <Glyph
      aria-hidden
      className={cn("size-3.5 shrink-0", pulse && "console-status-pulse", className)}
      strokeWidth={1.75}
    />
  );
}
