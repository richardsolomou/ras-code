import { useDndContext, useDroppable } from "@dnd-kit/core";
import { scopedThreadKey } from "@ras-code/client-runtime/environment";
import type { ScopedThreadRef } from "@ras-code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import ChatView from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  canSplitPaneRow,
  clampPaneFraction,
  planPaneFocusChange,
  shouldCollapseOnNavigation,
  useChatPaneStore,
  type ChatPaneSide,
  type FocusedPane,
} from "../../chatPaneStore";
import { useRoutedThreadRef } from "../../hooks/useRoutedThreadRef";
import {
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { buildThreadRouteParams, resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { paneDropZoneId, readThreadDrag } from "../../threadDrag";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PaneFocusProvider } from "./paneFocus";

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

/**
 * Focus follows the pointer into a pane, in the capture phase: transcripts stop
 * propagation on plenty of their own clicks, so a bubbled handler would miss
 * whichever spot the user happened to hit. Capturing is safe because focus only
 * moves a highlight and decides which pane answers window shortcuts — the click
 * it precedes still lands on the control the user aimed at.
 */
function usePaneFocusHandler(pane: FocusedPane) {
  const focusPane = useChatPaneStore((state) => state.focusPane);
  return useCallback(() => focusPane(pane), [focusPane, pane]);
}

const PANE_KEYBOARD_STEP = 0.02;

/** Flex order slots. The routed pane and the companion trade these on a swap so
 *  neither remounts and neither moves on screen. */
const ORDER_BY_SIDE = { left: 0, right: 2 } as const;

/** Publishes the pane row's width so anything offering a split can check for room. */
function useMeasureRowWidth(): (node: HTMLDivElement | null) => void {
  const setRowWidth = useChatPaneStore((state) => state.setRowWidth);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      setRowWidth(node.clientWidth);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setRowWidth(entry.contentRect.width);
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [setRowWidth],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return ref;
}

/**
 * Halves of the pane row that take a dropped thread. Rendered only while a
 * thread is in flight, and outlined rather than scrimmed so the transcripts
 * underneath stay readable while you aim.
 */
function PaneDropZone({
  side,
  label,
  visible,
}: {
  side: ChatPaneSide;
  label: string;
  visible: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropZoneId(side),
    data: { kind: "pane-drop", side },
  });

  return (
    <div
      ref={setNodeRef}
      data-testid={`chat-pane-drop-${side}`}
      className={`pointer-events-none flex flex-1 items-center justify-center rounded-lg transition-colors ${
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
      <PaneDropZone
        side="left"
        visible={dragging}
        label={splitActive ? "Replace left pane" : "Open on the left"}
      />
      <PaneDropZone
        side="right"
        visible={dragging}
        label={splitActive ? "Replace right pane" : "Open on the right"}
      />
    </div>
  );
}

function PaneDivider({
  leftFraction,
  onFractionChange,
}: {
  leftFraction: number;
  onFractionChange: (fraction: number) => void;
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

      const handleMove = (moveEvent: PointerEvent) => {
        onFractionChange((moveEvent.clientX - rowRect.left) / rowRect.width);
      };
      const handleUp = () => {
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
      };
      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    },
    [onFractionChange],
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
        onFractionChange(leftFraction + step);
      }}
      onDoubleClick={() => onFractionChange(0.5)}
    >
      {/* The grab area is wider than the rule, so the divider stays hairline
          without being a pixel-hunt. */}
      <span className="-inset-x-1.5 absolute inset-y-0 group-hover:bg-accent/40 group-focus-visible:bg-accent/40" />
    </div>
  );
}

function CompanionPaneControls({
  onClose,
  onMakePrimary,
}: {
  onClose: () => void;
  onMakePrimary: () => void;
}) {
  return (
    <div className="-ms-1 flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Make this the primary pane"
              onClick={onMakePrimary}
            >
              <ArrowLeftRightIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Make primary (takes keyboard shortcuts)</TooltipPopup>
      </Tooltip>
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
  onMakePrimary,
}: {
  companion: ScopedThreadRef;
  grow: number;
  isFocused: boolean;
  order: number;
  onClose: () => void;
  onMakePrimary: () => void;
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
  const paneControls = <CompanionPaneControls onClose={onClose} onMakePrimary={onMakePrimary} />;
  const ready = renderState === "ready" || (renderState === "loading" && threadShell !== null);
  const takeFocus = usePaneFocusHandler("companion");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus mirrors pointer focus
    <div
      data-chat-pane="companion"
      data-chat-pane-focused={isFocused ? "true" : "false"}
      className="relative flex min-w-0 flex-col bg-background"
      style={{ order, flexGrow: grow, flexBasis: 0 }}
      onPointerDownCapture={takeFocus}
      onFocusCapture={takeFocus}
    >
      <PaneFocusRule isFocused={isFocused} />
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
    </div>
  );
}

/**
 * The chat inset, as one pane or two.
 *
 * The routed pane is always the primary one — it owns the URL and the global
 * shortcuts — and the companion sits beside it as a second live thread. Both
 * panes keep a fixed position in the DOM and are placed by flex `order`, so
 * promoting the companion swaps which thread each pane renders without either
 * one remounting or sliding across the screen.
 */
export function ChatPanes({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const rowRef = useMeasureRowWidth();
  const routed = useRoutedThreadRef();
  const routedKey = routed ? scopedThreadKey(routed) : null;

  const companion = useChatPaneStore((state) => state.companion);
  const focusedPane = useChatPaneStore((state) => state.focusedPane);
  const companionSide = useChatPaneStore((state) => state.companionSide);
  const leftFraction = useChatPaneStore((state) => state.leftFraction);
  const rowWidth = useChatPaneStore((state) => state.rowWidth);
  const closeCompanion = useChatPaneStore((state) => state.closeCompanion);
  const setLeftFraction = useChatPaneStore((state) => state.setLeftFraction);
  const applyLayout = useChatPaneStore((state) => state.applyLayout);
  const reconcile = useChatPaneStore((state) => state.reconcile);

  const threadRefs = useThreadRefs();
  const knownThreadKeys = useMemo(() => new Set(threadRefs.map(scopedThreadKey)), [threadRefs]);

  // `undefined` until the first run, which keeps a companion restored from a
  // previous session from reading as a navigation and closing itself.
  const previousRoutedKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previousRoutedKey = previousRoutedKeyRef.current;
    previousRoutedKeyRef.current = routedKey;
    const { companion } = useChatPaneStore.getState();
    if (
      previousRoutedKey !== undefined &&
      shouldCollapseOnNavigation({
        previousRoutedKey,
        nextRoutedKey: routedKey,
        companionKey: companion ? scopedThreadKey(companion) : null,
      })
    ) {
      closeCompanion();
      return;
    }
    reconcile({ knownThreadKeys, routedKey });
  }, [closeCompanion, knownThreadKeys, reconcile, routedKey]);

  const focusRoutedPane = usePaneFocusHandler("routed");

  const handleMakePrimary = useCallback(() => {
    const plan = planPaneFocusChange(useChatPaneStore.getState(), routed);
    if (!plan) return;
    applyLayout(plan.layout);
    // Replaces rather than pushes: promoting a pane is a focus change, and a
    // back stack full of them buries the navigations worth undoing.
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(plan.navigateTo),
      replace: true,
    });
  }, [applyLayout, navigate, routed]);

  // A row too narrow for two readable transcripts shows only the routed pane.
  // The companion is suspended rather than dropped, so widening the window (or
  // collapsing the sidebar) brings it straight back.
  const canSplit = canSplitPaneRow(rowWidth);
  const splitActive = companion !== null && canSplit;
  const clampedLeftFraction = clampPaneFraction(leftFraction, rowWidth);
  const routedGrow = splitActive
    ? companionSide === "left"
      ? 1 - clampedLeftFraction
      : clampedLeftFraction
    : 1;
  const companionFocused = splitActive && focusedPane === "companion";
  const routedStyle: CSSProperties = {
    order: splitActive ? ORDER_BY_SIDE[companionSide === "left" ? "right" : "left"] : 0,
    flexGrow: routedGrow,
    flexBasis: 0,
  };

  return (
    <DiffWorkerPoolProvider>
      <div ref={rowRef} data-chat-panes="" className="relative flex min-w-0 flex-1">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pane focus mirrors pointer focus */}
        <div
          className="relative flex min-w-0"
          data-chat-pane="routed"
          data-chat-pane-focused={companionFocused ? "false" : "true"}
          style={routedStyle}
          onPointerDownCapture={focusRoutedPane}
          onFocusCapture={focusRoutedPane}
        >
          {splitActive ? <PaneFocusRule isFocused={!companionFocused} /> : null}
          <PaneFocusProvider value={!companionFocused}>{children}</PaneFocusProvider>
        </div>
        {splitActive && companion ? (
          <>
            <PaneDivider leftFraction={clampedLeftFraction} onFractionChange={setLeftFraction} />
            <CompanionPane
              companion={companion}
              isFocused={companionFocused}
              grow={1 - routedGrow}
              order={ORDER_BY_SIDE[companionSide]}
              onClose={closeCompanion}
              onMakePrimary={handleMakePrimary}
            />
          </>
        ) : null}
        <PaneDropOverlay canSplit={canSplit} splitActive={splitActive} />
      </div>
    </DiffWorkerPoolProvider>
  );
}
