import type { LucideIcon } from "lucide-react";
import { CheckIcon, CircleDashedIcon, FlagIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Console state channel. Colour carries the state and the glyph repeats it,
 * so a lamp stays readable without colour.
 *
 * `idle` is a station at rest — nothing running, nothing waiting on the user —
 * and shows an unlit lamp with no mark. `settled` is the separate, explicit
 * "done, not archived" state and shows the check alone, lamp off.
 */
export type LampState = "working" | "waiting" | "failed" | "settled" | "idle";

const LAMP_GLYPHS: Partial<Record<LampState, LucideIcon>> = {
  working: CircleDashedIcon,
  waiting: FlagIcon,
  failed: XIcon,
  settled: CheckIcon,
};

export function StatusLamp({
  state,
  pulse = false,
  size,
  className,
}: {
  state: LampState;
  pulse?: boolean;
  /** Lamp edge in pixels; defaults to the 10px console bezel. */
  size?: number;
  className?: string | undefined;
}) {
  if (state === "settled") {
    return null;
  }
  return (
    <span
      aria-hidden
      data-lamp={state}
      style={size === undefined ? undefined : { width: size, height: size }}
      className={cn("console-lamp", pulse && "console-lamp-pulse", className)}
    />
  );
}

export function StatusGlyph({
  state,
  className,
}: {
  state: LampState;
  className?: string | undefined;
}) {
  const Glyph = LAMP_GLYPHS[state];
  if (Glyph === undefined) {
    return null;
  }
  return <Glyph aria-hidden className={cn("size-3.5 shrink-0", className)} strokeWidth={1.75} />;
}

/** Lamp and glyph as one indicator, the pairing used in every status slot. */
export function StatusMark({
  state,
  pulse = false,
  className,
  lampClassName,
  glyphClassName,
}: {
  state: LampState;
  pulse?: boolean;
  className?: string | undefined;
  lampClassName?: string | undefined;
  glyphClassName?: string | undefined;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <StatusLamp state={state} pulse={pulse} className={lampClassName} />
      <StatusGlyph state={state} className={glyphClassName} />
    </span>
  );
}
