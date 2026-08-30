import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DroppableContainer,
  type Modifier,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useCallback, type ReactNode } from "react";

import { useChatPaneStore } from "../../chatPaneStore";
import { useRoutedThreadRef } from "../../hooks/useRoutedThreadRef";
import {
  isPinnedReorderDrag,
  readPaneDrop,
  readThreadDrag,
  runPinnedReorder,
} from "../../threadDrag";

function isPaneDropContainer(container: DroppableContainer): boolean {
  return container.data.current?.kind === "pane-drop";
}

/**
 * Axis and scroll locks belong to the pinned reorder alone. A plain thread drag
 * has to be able to leave the sidebar, so it passes the transform through
 * untouched.
 */
const THREAD_DRAG_MODIFIERS: Modifier[] = [
  (args) => (isPinnedReorderDrag(args.active) ? restrictToVerticalAxis(args) : args.transform),
  (args) =>
    isPinnedReorderDrag(args.active) ? restrictToFirstScrollableAncestor(args) : args.transform,
];

/**
 * Pane zones win whenever the pointer is inside one, and the sortable list is
 * matched by rect as before.
 *
 * The two are read differently on purpose: a pinned card stays axis-locked in
 * the sidebar, so its rect never reaches a pane. The pointer does, and dnd-kit
 * leaves pointer coordinates unmodified — which is what lets one gesture serve
 * both destinations.
 */
const threadDragCollisionDetection: CollisionDetection = (args) => {
  const paneCollisions = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter(isPaneDropContainer),
  });
  if (paneCollisions.length > 0) return paneCollisions;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => !isPaneDropContainer(container),
    ),
  });
};

/**
 * Follows the pointer for drags that leave the sidebar. Pinned reorders move
 * their own card instead, so this stays unmounted for them and the sortable
 * list behaves exactly as it does without panes.
 */
function ThreadDragPreview() {
  const { active } = useDndContext();
  const thread = readThreadDrag(active);
  if (!thread || thread.reorderable) return null;

  return (
    <DragOverlay dropAnimation={null}>
      <div className="pointer-events-none max-w-64 truncate rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground text-xs shadow-md">
        {thread.title}
      </div>
    </DragOverlay>
  );
}

/**
 * One drag system for the whole app shell.
 *
 * It has to sit above both the sidebar and the chat panes, because a thread
 * dragged out of the list has to be able to reach a pane. dnd-kit's pointer
 * sensor cancels native HTML5 drags on any element it manages, so the two
 * cannot be split across separate mechanisms.
 */
export function ThreadDragProvider({ children }: { children: ReactNode }) {
  const routed = useRoutedThreadRef();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const thread = readThreadDrag(event.active);
      const paneDrop = readPaneDrop(event.over);
      if (thread && paneDrop) {
        useChatPaneStore
          .getState()
          .splitWithThread({ routed, dropped: thread.ref, side: paneDrop.side });
        return;
      }
      runPinnedReorder(event);
    },
    [routed],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={threadDragCollisionDetection}
      modifiers={THREAD_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      {children}
      <ThreadDragPreview />
    </DndContext>
  );
}
