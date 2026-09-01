import { useDndContext, useDroppable } from "@dnd-kit/core";
import { scopedThreadKey } from "@ras-code/client-runtime/environment";
import type { ScopedThreadRef } from "@ras-code/contracts";
import { XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
} from "react";

import ChatView from "../ChatView";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  canSplitPaneRow,
  clampPaneFraction,
  isCompanionVisible,
  oppositePaneSide,
  planRouteChange,
  takeRouteOpenPane,
  useChatPaneStore,
  type ChatPaneSide,
  type FocusedPane,
} from "../../chatPaneStore";
import { useRoutedThreadRef, useRouteTargetId } from "../../hooks/useRoutedThreadRef";
import {
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { paneDropZoneId, readThreadDrag } from "../../threadDrag";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PaneFocusProvider,
  PaneIsRoutedProvider,
  paneHasTextSelection,
  registerPaneFocusRestorer,
  restorePaneFocus,
  restorePaneFocusAfterClick,
} from "./paneFocus";

/**
 * Which pane the keyboard is aimed at, drawn only while the inset is split. A
 * static rule rather than a glow or a tint: it sits over two live transcripts
 * and must not repaint.
 */
function PaneFocusRule({ isFocused }: { isFocused: boolean }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 top-0 z-40 h-0.5 ${
        isFocused ? "bg-accent" : "bg-transparent"
      }`}
    />
  );
}

type PaneFocusMemory = Record<FocusedPane, HTMLElement | null>;

/** Capture sees nested transcript controls that stop pointer events from bubbling. */
function usePaneFocusHandlers(pane: FocusedPane, memoryRef: MutableRefObject<PaneFocusMemory>) {
  const focusPane = useChatPaneStore((state) => state.focusPane);
  const onFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      focusPane(pane);
      if (event.target instanceof HTMLElement && event.target !== event.currentTarget) {
        memoryRef.current[pane] = event.target;
      }
    },
    [focusPane, memoryRef, pane],
  );
  const onPointerDownCapture = useCallback(() => {
    focusPane(pane);
  }, [focusPane, pane]);
  const onClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      restorePaneFocusAfterClick(
        event.currentTarget,
        event.target,
        document.activeElement,
        memoryRef.current[pane],
        window.getSelection(),
      );
    },
    [memoryRef, pane],
  );
  return { onClickCapture, onFocusCapture, onPointerDownCapture };
}

const PANE_KEYBOARD_STEP = 0.02;

/**
 * The share of the row given to the left pane, as a CSS custom property.
 *
 * Written imperatively and never through React: a render that sees an unchanged
 * value writes nothing, so if React owned the property and anything else cleared
 * it, both panes would resolve `flex-grow` to 0 and the chat area would go blank.
 * One writer, and a fallback in the `calc()` for the frame before the first
 * measurement.
 */
const PANE_FRACTION_VARIABLE = "--chat-pane-left-fraction";
const DEFAULT_PANE_FRACTION = 0.5;

function writePaneFraction(row: HTMLElement, fraction: number, rowWidth: number): void {
  row.style.setProperty(PANE_FRACTION_VARIABLE, `${clampPaneFraction(fraction, rowWidth)}`);
}

/** `left` takes the fraction, `right` takes the remainder. */
function paneGrow(side: ChatPaneSide): string {
  return side === "left"
    ? `calc(var(${PANE_FRACTION_VARIABLE}, ${DEFAULT_PANE_FRACTION}))`
    : `calc(1 - var(${PANE_FRACTION_VARIABLE}, ${DEFAULT_PANE_FRACTION}))`;
}

/** Flex order slots. The routed pane and the companion trade these on a swap so
 *  neither remounts and neither moves on screen. */
const ORDER_BY_SIDE = { left: 0, right: 2 } as const;

/**
 * Watches the pane row and publishes only whether it has room for two panes.
 *
 * The measured width stays in a ref: it changes every frame of a window or
 * sidebar resize, and pushing that through the store would re-render the
 * companion's entire ChatView per frame. Only crossing the threshold is a fact
 * React needs. The ref is what the divider clamps against.
 */
function useMeasureRow(): {
  rowRef: (node: HTMLDivElement | null) => void;
  rowNodeRef: RefObject<HTMLDivElement | null>;
  rowWidthRef: RefObject<number>;
} {
  const setCanSplit = useChatPaneStore((state) => state.setCanSplit);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowNodeRef = useRef<HTMLDivElement | null>(null);
  const rowWidthRef = useRef(0);

  const rowRef = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      rowNodeRef.current = node;
      if (!node) {
        setCanSplit(false);
        return;
      }
      const publish = (width: number) => {
        rowWidthRef.current = width;
        // Re-clamped against the new width here rather than at render, because a
        // resize that stays on one side of the split threshold produces no
        // re-render and would otherwise leave a pane under its minimum.
        writePaneFraction(node, useChatPaneStore.getState().leftFraction, width);
        setCanSplit(canSplitPaneRow(width));
      };
      publish(node.clientWidth);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) publish(entry.contentRect.width);
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [setCanSplit],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { rowRef, rowNodeRef, rowWidthRef };
}

/**
 * Halves of the pane row that take a dropped thread. Rendered only while a
 * thread is in flight, and outlined rather than scrimmed so the transcripts
 * underneath stay readable while you aim.
 */
function PaneDropZone({
  side,
  grow,
  label,
  visible,
}: {
  side: ChatPaneSide;
  grow: string;
  label: string;
  visible: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropZoneId(side),
    data: { kind: "pane-drop", side },
  });

  return (
    <>
      <div
        ref={setNodeRef}
        data-testid={`chat-pane-drop-${side}`}
        style={{ flexGrow: grow, flexBasis: 0 }}
        className={`pointer-events-none flex min-w-0 items-center justify-center rounded-lg transition-colors ${
          visible ? "" : "invisible"
        } ${isOver ? "bg-accent/10 ring-2 ring-accent ring-inset" : "ring-1 ring-border ring-inset"}`}
      >
        <span
          className={`rounded-md bg-accent px-2 py-1 font-medium text-[11px] text-accent-foreground shadow-sm transition-opacity ${
            isOver ? "opacity-100" : "opacity-0"
          }`}
        >
          {label}
        </span>
      </div>
    </>
  );
}

/**
 * Stays mounted and only hides itself, because dnd-kit measures droppables when a
 * drag starts. Zones that appear on drag start miss that measurement, and the
 * first drag after a navigation silently drops nowhere.
 *
 * No zones at all on a row too narrow to hold two panes: offering a target that
 * would immediately suspend itself is a lie.
 */
function PaneDropOverlay({ canSplit, splitActive }: { canSplit: boolean; splitActive: boolean }) {
  const { active } = useDndContext();
  if (!canSplit) return null;
  const dragging = readThreadDrag(active) !== null;
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-30 flex gap-2 p-2 ${dragging ? "" : "invisible"}`}
    >
      {(["left", "right"] as const).map((side) => (
        <PaneDropZone
          key={side}
          side={side}
          grow={splitActive ? paneGrow(side) : "1"}
          visible={dragging}
          label={splitActive ? "Open in this pane" : `Open on the ${side}`}
        />
      ))}
    </div>
  );
}

/**
 * Resizes by writing a CSS variable on the row and committing to the store once,
 * on release. The in-flight fraction never reaches React: the companion pane
 * cannot be memoized — its width is the thing changing — so a state write per
 * pointer event would re-render its whole ChatView at pointer rate.
 */
function PaneDivider({
  leftFraction,
  onFractionChange,
}: {
  leftFraction: number;
  onFractionChange: (fraction: number, rowWidth: number) => void;
}) {
  const dividerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const row = dividerRef.current?.parentElement;
      if (!row || event.button !== 0) return;
      event.preventDefault();
      const rowRect = row.getBoundingClientRect();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      let pendingFraction = leftFraction;
      const handleMove = (moveEvent: PointerEvent) => {
        pendingFraction = (moveEvent.clientX - rowRect.left) / rowRect.width;
        // A style mutation the browser already batches to the next frame; going
        // through React instead would re-render the companion's ChatView on
        // every pointer event.
        writePaneFraction(row, pendingFraction, rowRect.width);
      };
      const handleUp = () => {
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
        // Rewritten, never removed: this property is the row's only source for
        // the split, and clearing it collapses both panes to nothing.
        writePaneFraction(row, pendingFraction, rowRect.width);
        onFractionChange(pendingFraction, rowRect.width);
      };
      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    },
    [leftFraction, onFractionChange],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: role="separator" with arrow-key resizing below
    <div
      ref={dividerRef}
      role="separator"
      aria-label="Resize panes"
      aria-orientation="vertical"
      aria-valuenow={Math.round(leftFraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-testid="chat-pane-divider"
      style={{ order: 1 }}
      className="group relative z-20 w-1 shrink-0 cursor-col-resize bg-border outline-none"
      onPointerDown={handlePointerDown}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.key === "ArrowLeft" ? -PANE_KEYBOARD_STEP : PANE_KEYBOARD_STEP;
        const width = dividerRef.current?.parentElement?.clientWidth ?? 0;
        onFractionChange(leftFraction + step, width);
      }}
      onDoubleClick={() =>
        onFractionChange(0.5, dividerRef.current?.parentElement?.clientWidth ?? 0)
      }
    >
      {/* The grab area is wider than the rule, so the divider stays hairline
          without being a pixel-hunt. */}
      <span className="-inset-x-1.5 absolute inset-y-0 group-hover:bg-accent/40 group-focus-visible:bg-accent/40" />
    </div>
  );
}

function CompanionPaneControls({ onClose }: { onClose: () => void }) {
  return (
    <div className="-ms-1 flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Close split pane"
              onClick={onClose}
            >
              <XIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Close split pane</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function CompanionPane({
  companion,
  grow,
  isFocused,
  order,
  onClose,
  focusMemoryRef,
}: {
  companion: ScopedThreadRef;
  grow: string;
  isFocused: boolean;
  order: number;
  onClose: () => void;
  focusMemoryRef: MutableRefObject<PaneFocusMemory>;
}) {
  const shell = useEnvironmentQuery(environmentShell.stateAtom(companion.environmentId));
  const threadShell = useThreadShell(companion);
  const threadDetail = useThreadDetail(companion);
  const threadStatus = useThreadStatus(companion);
  // Gated exactly as the routed thread route gates its own ChatView. ChatView
  // returns an empty state before some of its hooks when it has no thread, so
  // mounting it against one that has not loaded crashes on the render that
  // fills in.
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    serverThreadShellExists: threadShell !== null,
    serverThreadDetailExists: threadDetail !== null,
    serverThreadDetailDeleted: threadStatus === "deleted",
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: threadDetail !== null,
    shellExists: threadShell !== null,
    status: threadStatus,
  });
  const paneControls = <CompanionPaneControls onClose={onClose} />;
  const ready = renderState === "ready" || (renderState === "loading" && threadShell !== null);
  const focusHandlers = usePaneFocusHandlers("companion", focusMemoryRef);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus mirrors pointer focus
    <div
      data-chat-pane="companion"
      data-chat-pane-focused={isFocused ? "true" : "false"}
      className="relative flex min-w-0 flex-col bg-background"
      style={{ order, flexGrow: grow, flexBasis: 0 }}
      onClickCapture={focusHandlers.onClickCapture}
      onPointerDownCapture={focusHandlers.onPointerDownCapture}
      onFocusCapture={focusHandlers.onFocusCapture}
    >
      <PaneFocusRule isFocused={isFocused} />
      <PaneIsRoutedProvider value={false}>
        <PaneFocusProvider value={isFocused}>
          {ready ? (
            <ChatView
              environmentId={companion.environmentId}
              threadId={companion.threadId}
              routeKind="server"
              reserveTitleBarControlInset={false}
              threadSyncPhase={threadSyncPhase}
              paneControls={paneControls}
            />
          ) : (
            // The controls stay reachable while the thread loads, so a pane that
            // never resolves is still closable.
            <WorkspacePageHeader className="bg-background">{paneControls}</WorkspacePageHeader>
          )}
        </PaneFocusProvider>
      </PaneIsRoutedProvider>
    </div>
  );
}

/**
 * The chat inset, as one pane or two.
 *
 * One pane backs the address bar while both panes share the same interaction
 * model. The routed and companion containers stay mounted and use flex `order`,
 * so changing the address-bar thread does not move either pane on screen.
 */
export function ChatPanes({ children }: { children: ReactNode }) {
  const { rowRef, rowNodeRef, rowWidthRef } = useMeasureRow();
  const routed = useRoutedThreadRef();
  const routedKey = routed ? scopedThreadKey(routed) : null;
  const routeId = useRouteTargetId();
  const focusMemoryRef = useRef<PaneFocusMemory>({ routed: null, companion: null });
  const previousRouteRef = useRef<{
    routeId: string | null;
    routed: ScopedThreadRef | null;
  } | null>(null);

  const companion = useChatPaneStore((state) => state.companion);
  const focusedPane = useChatPaneStore((state) => state.focusedPane);
  const companionSide = useChatPaneStore((state) => state.companionSide);
  const leftFraction = useChatPaneStore((state) => state.leftFraction);
  const canSplit = useChatPaneStore((state) => state.canSplit);
  const closeCompanion = useChatPaneStore((state) => state.closeCompanion);
  const setLeftFraction = useChatPaneStore((state) => state.setLeftFraction);
  const applyLayout = useChatPaneStore((state) => state.applyLayout);
  const reconcile = useChatPaneStore((state) => state.reconcile);

  const threadRefs = useThreadRefs();
  const knownThreadKeys = useMemo(() => new Set(threadRefs.map(scopedThreadKey)), [threadRefs]);

  useLayoutEffect(() => {
    const previous = previousRouteRef.current;
    previousRouteRef.current = { routeId, routed };
    if (!previous) return;
    const openedFromPane = previous.routeId === routeId ? null : takeRouteOpenPane(routeId);
    const paneState = useChatPaneStore.getState();
    const nextLayout = planRouteChange({
      layout: paneState,
      openedFromPane,
      previousRouteId: previous.routeId,
      nextRouteId: routeId,
      previousRouted: previous.routed,
      nextRouted: routed,
    });
    if (nextLayout !== paneState) {
      applyLayout(nextLayout);
    }
  }, [applyLayout, routeId, routed]);

  useEffect(() => {
    reconcile({ knownThreadKeys, routedKey });
  }, [knownThreadKeys, reconcile, routedKey]);

  // Keeps the DOM in step with a fraction that changed anywhere but the divider:
  // rehydration, the arrow keys, or a double-click reset.
  useLayoutEffect(() => {
    const row = rowNodeRef.current;
    if (row) writePaneFraction(row, leftFraction, rowWidthRef.current);
  }, [leftFraction, rowNodeRef, rowWidthRef]);

  const routedFocusHandlers = usePaneFocusHandlers("routed", focusMemoryRef);

  // A row too narrow for two readable transcripts shows only the routed pane.
  // The companion is suspended rather than dropped, so widening the window (or
  // collapsing the sidebar) brings it straight back.
  const splitActive = isCompanionVisible({
    canSplit,
    companion,
    companionSide,
    focusedPane,
    leftFraction,
  });
  const companionFocused = splitActive && focusedPane === "companion";

  useEffect(() => {
    if (!splitActive) focusMemoryRef.current.companion = null;
  }, [splitActive]);

  useLayoutEffect(() => {
    if (isCommandPaletteOpen()) return;
    const pane = splitActive ? focusedPane : "routed";
    const root = rowNodeRef.current?.querySelector<HTMLElement>(`[data-chat-pane="${pane}"]`);
    if (!root || root.contains(document.activeElement)) return;
    restorePaneFocus(root, focusMemoryRef.current[pane]);
  }, [focusedPane, rowNodeRef, splitActive]);

  useEffect(
    () =>
      registerPaneFocusRestorer(() => {
        const paneState = useChatPaneStore.getState();
        const pane = isCompanionVisible(paneState) ? paneState.focusedPane : "routed";
        const root = rowNodeRef.current?.querySelector<HTMLElement>(`[data-chat-pane="${pane}"]`);
        return root ? restorePaneFocus(root, focusMemoryRef.current[pane]) : false;
      }),
    [rowNodeRef],
  );

  useEffect(() => {
    const restoreAfterWindowFocus = () => {
      if (document.activeElement !== document.body) return;
      const focused = useChatPaneStore.getState().focusedPane;
      const root =
        rowNodeRef.current?.querySelector<HTMLElement>(`[data-chat-pane="${focused}"]`) ??
        rowNodeRef.current?.querySelector<HTMLElement>('[data-chat-pane="routed"]');
      if (!root) return;
      if (paneHasTextSelection(root, window.getSelection())) return;
      const pane = root.dataset.chatPane === "companion" ? "companion" : "routed";
      restorePaneFocus(root, focusMemoryRef.current[pane]);
    };
    window.addEventListener("focus", restoreAfterWindowFocus);
    return () => window.removeEventListener("focus", restoreAfterWindowFocus);
  }, [rowNodeRef]);
  // Both panes grow from one custom property, so the divider retunes the split
  // by writing a variable rather than re-rendering either ChatView.
  const routedSide = oppositePaneSide(companionSide);
  const routedStyle: CSSProperties = {
    order: splitActive ? ORDER_BY_SIDE[routedSide] : 0,
    flexGrow: splitActive ? paneGrow(routedSide) : 1,
    flexBasis: 0,
  };

  return (
    <div ref={rowRef} data-chat-panes="" className="relative flex min-w-0 flex-1">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pane focus mirrors pointer focus */}
      <div
        className="relative flex min-w-0"
        data-chat-pane="routed"
        data-chat-pane-focused={companionFocused ? "false" : "true"}
        style={routedStyle}
        onClickCapture={routedFocusHandlers.onClickCapture}
        onPointerDownCapture={routedFocusHandlers.onPointerDownCapture}
        onFocusCapture={routedFocusHandlers.onFocusCapture}
      >
        {splitActive ? <PaneFocusRule isFocused={!companionFocused} /> : null}
        <PaneFocusProvider value={!companionFocused}>{children}</PaneFocusProvider>
      </div>
      {splitActive && companion ? (
        <>
          <PaneDivider leftFraction={leftFraction} onFractionChange={setLeftFraction} />
          <CompanionPane
            companion={companion}
            isFocused={companionFocused}
            grow={paneGrow(companionSide)}
            order={ORDER_BY_SIDE[companionSide]}
            onClose={closeCompanion}
            focusMemoryRef={focusMemoryRef}
          />
        </>
      ) : null}
      <PaneDropOverlay canSplit={canSplit} splitActive={splitActive} />
    </div>
  );
}
