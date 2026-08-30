/**
 * The drag that carries a thread out of the sidebar.
 *
 * One gesture, two destinations: dropping back inside the pinned list reorders
 * it, dropping on a pane zone splits the inset. `onDragEnd` picks by what the
 * pointer is over, so a pinned card can do either without a second affordance.
 */
import type { ScopedThreadRef } from "@ras-code/contracts";
import type { Active, DragEndEvent, Over } from "@dnd-kit/core";

import type { ChatPaneSide } from "./chatPaneStore";

export interface ThreadDragData {
  kind: "thread";
  ref: ScopedThreadRef;
  title: string;
  /**
   * Whether this row also participates in the pinned sortable list. Reorderable
   * cards keep their axis-locked transform, so the pointer — not the card —
   * is what reaches a pane zone.
   */
  reorderable: boolean;
}

export interface PaneDropData {
  kind: "pane-drop";
  side: ChatPaneSide;
}

export function paneDropZoneId(side: ChatPaneSide): string {
  return `chat-pane-drop:${side}`;
}

export function readThreadDrag(active: Active | null | undefined): ThreadDragData | null {
  const data = active?.data.current;
  return data && data.kind === "thread" ? (data as ThreadDragData) : null;
}

export function readPaneDrop(over: Over | null | undefined): PaneDropData | null {
  const data = over?.data.current;
  return data && data.kind === "pane-drop" ? (data as PaneDropData) : null;
}

/** Whether the dragged row is a pinned card that also takes part in the sortable list. */
export function isPinnedReorderDrag(active: Active | null | undefined): boolean {
  return readThreadDrag(active)?.reorderable === true;
}

/**
 * The pinned list's reorder handler, published by the sidebar and run by the
 * layout that owns the DndContext.
 *
 * The context has to wrap both the sidebar and the panes for a drag to reach
 * them, so it cannot live next to the reorder state it drives. A module-level
 * handle matches the other cross-tree buses here and keeps that state in the
 * sidebar, where it belongs.
 */
let pinnedReorderHandler: ((event: DragEndEvent) => void) | null = null;

export function setPinnedReorderHandler(handler: (event: DragEndEvent) => void): () => void {
  pinnedReorderHandler = handler;
  return () => {
    if (pinnedReorderHandler === handler) pinnedReorderHandler = null;
  };
}

export function runPinnedReorder(event: DragEndEvent): void {
  pinnedReorderHandler?.(event);
}
