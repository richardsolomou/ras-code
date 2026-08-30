/**
 * Side-by-side chat panes.
 *
 * The routed pane is the router's outlet; this store holds the optional
 * companion beside it, which half it occupies, and which of the two the user is
 * working in. Focus is tracked separately from the route on purpose — see
 * `FocusedPane` — and `companionSide` flips when the two trade places so neither
 * pane moves on screen.
 */
import { scopedThreadKey } from "@ras-code/client-runtime/environment";
import type { ScopedThreadRef } from "@ras-code/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

const CHAT_PANES_STORAGE_KEY = "ras-code:chat-panes:v1";
const CHAT_PANES_STORAGE_VERSION = 1;

/** Narrowest a split pane may get before it stops being a usable transcript. */
export const CHAT_PANE_MIN_WIDTH = 30 * 16;

export type ChatPaneSide = "left" | "right";

/**
 * Which pane the user is working in. Deliberately not the same thing as the
 * routed pane: the routed one is the router's outlet, so making the URL follow
 * focus would swap the two panes' DOM nodes out from under a click. Focus is
 * cheap client state, and the URL only moves when the user asks for it.
 */
export type FocusedPane = "routed" | "companion";

interface PaneRouteOpenIntent {
  pane: FocusedPane;
  routeId: string;
}

let pendingRouteOpenIntent: PaneRouteOpenIntent | null = null;

export interface ChatPaneLayout {
  /** The thread beside the routed one, or null while the inset holds one pane. */
  companion: ScopedThreadRef | null;
  /** The half the companion occupies; the routed pane takes the other. */
  companionSide: ChatPaneSide;
  /** The pane that takes the sidebar highlight and the window-level shortcuts. */
  focusedPane: FocusedPane;
  /**
   * Share of the pane row given to the left pane. Tied to a side rather than to
   * focus, so swapping focus leaves both widths where the user put them.
   */
  leftFraction: number;
}

/** A layout plus whether the row it sits in can currently show two panes. */
export type ChatPaneMeasuredLayout = ChatPaneLayout & { canSplit: boolean };

export const INITIAL_CHAT_PANE_LAYOUT: ChatPaneLayout = {
  companion: null,
  companionSide: "right",
  focusedPane: "routed",
  leftFraction: 0.5,
};

/**
 * Whether the companion is actually on screen. A row too narrow to hold two
 * readable panes suspends it, and a suspended pane can hold neither focus nor
 * the sidebar's active row.
 */
export function isCompanionVisible(layout: ChatPaneMeasuredLayout): boolean {
  return layout.companion !== null && layout.canSplit;
}

export async function openDraftInFocusedPane<T>(
  draftId: string,
  navigate: () => Promise<T>,
): Promise<T> {
  const paneState = useChatPaneStore.getState();
  const intent = {
    pane: isCompanionVisible(paneState) ? paneState.focusedPane : "routed",
    routeId: `draft:${draftId}`,
  } satisfies PaneRouteOpenIntent;
  pendingRouteOpenIntent = intent;
  try {
    return await navigate();
  } catch (error) {
    if (pendingRouteOpenIntent === intent) pendingRouteOpenIntent = null;
    throw error;
  }
}

export function takeRouteOpenPane(routeId: string | null): FocusedPane | null {
  const intent = pendingRouteOpenIntent;
  pendingRouteOpenIntent = null;
  return intent?.routeId === routeId ? intent.pane : null;
}

/**
 * Whether a thread can usefully be opened beside the current one. False for a
 * thread already on screen in either pane, and for a row with no space for two —
 * the menu must never offer a split that would do nothing.
 */
export function canOpenThreadInSplit(
  layout: ChatPaneMeasuredLayout,
  input: { routed: ScopedThreadRef | null; candidate: ScopedThreadRef },
): boolean {
  if (!layout.canSplit) return false;
  if (isSameThreadRef(input.routed, input.candidate)) return false;
  return !isSameThreadRef(layout.companion, input.candidate);
}

/** The thread the user is working in, which is what the sidebar marks active. */
export function selectFocusedThread(
  layout: ChatPaneMeasuredLayout,
  routed: ScopedThreadRef | null,
): ScopedThreadRef | null {
  if (layout.focusedPane === "companion" && isCompanionVisible(layout)) return layout.companion;
  return routed;
}

export function oppositePaneSide(side: ChatPaneSide): ChatPaneSide {
  return side === "left" ? "right" : "left";
}

export function isSameThreadRef(
  a: ScopedThreadRef | null | undefined,
  b: ScopedThreadRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

/** Whether a row of this width can hold two panes that are still readable. */
export function canSplitPaneRow(rowWidth: number): boolean {
  return Number.isFinite(rowWidth) && rowWidth >= CHAT_PANE_MIN_WIDTH * 2;
}

/**
 * The divider position, held far enough from both edges that neither pane drops
 * below `CHAT_PANE_MIN_WIDTH`. Falls back to a plain fraction clamp when the row
 * has not been measured yet, and centres the divider on a row too narrow to
 * satisfy the minimum on both sides at once.
 */
export function clampPaneFraction(fraction: number, rowWidth: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    return Math.min(0.75, Math.max(0.25, fraction));
  }
  const minimumFraction = CHAT_PANE_MIN_WIDTH / rowWidth;
  if (minimumFraction >= 0.5) return 0.5;
  return Math.min(1 - minimumFraction, Math.max(minimumFraction, fraction));
}

/**
 * The layout after dropping `dropped` on `side` of the pane row, or null when
 * the drop changes nothing: a thread cannot sit beside itself, and re-dropping
 * the companion on the side it already holds is a no-op.
 */
export function planPaneSplit(input: {
  layout: ChatPaneLayout;
  routed: ScopedThreadRef | null;
  dropped: ScopedThreadRef;
  side: ChatPaneSide;
}): ChatPaneLayout | null {
  const { dropped, layout, routed, side } = input;
  if (isSameThreadRef(routed, dropped)) return null;
  if (isSameThreadRef(layout.companion, dropped) && layout.companionSide === side) return null;
  return { ...layout, companion: dropped, companionSide: side, focusedPane: "companion" };
}

export interface ThreadOpenPlan {
  layout: ChatPaneLayout;
  navigateTo: ScopedThreadRef | null;
}

export function planThreadOpen(input: {
  layout: ChatPaneMeasuredLayout;
  routed: ScopedThreadRef | null;
  target: ScopedThreadRef;
}): ThreadOpenPlan {
  const { layout, routed, target } = input;
  if (!isCompanionVisible(layout)) {
    return { layout: { ...layout, focusedPane: "routed" }, navigateTo: target };
  }
  if (isSameThreadRef(routed, target)) {
    return { layout: { ...layout, focusedPane: "routed" }, navigateTo: null };
  }
  if (isSameThreadRef(layout.companion, target)) {
    return { layout: { ...layout, focusedPane: "companion" }, navigateTo: null };
  }
  if (layout.focusedPane === "companion") {
    return { layout: { ...layout, companion: target }, navigateTo: null };
  }
  return { layout, navigateTo: target };
}

export function planThreadDrop(input: {
  layout: ChatPaneMeasuredLayout;
  routed: ScopedThreadRef | null;
  target: ScopedThreadRef;
  side: ChatPaneSide;
}): ThreadOpenPlan | null {
  const { layout, routed, side, target } = input;
  if (!isCompanionVisible(layout)) {
    const nextLayout = planPaneSplit({ layout, routed, dropped: target, side });
    return nextLayout ? { layout: nextLayout, navigateTo: null } : null;
  }
  if (isSameThreadRef(routed, target)) {
    return {
      layout: {
        ...layout,
        companionSide: oppositePaneSide(side),
        focusedPane: "routed",
      },
      navigateTo: null,
    };
  }
  if (isSameThreadRef(layout.companion, target)) {
    return {
      layout: { ...layout, companionSide: side, focusedPane: "companion" },
      navigateTo: null,
    };
  }
  return planThreadOpen({
    layout: {
      ...layout,
      focusedPane: layout.companionSide === side ? "companion" : "routed",
    },
    routed,
    target,
  });
}

/** Places drafts and already-visible threads in the pane that opened them. */
export function planRouteChange(input: {
  layout: ChatPaneMeasuredLayout;
  openedFromPane: FocusedPane | null;
  previousRouteId: string | null;
  nextRouteId: string | null;
  previousRouted: ScopedThreadRef | null;
  nextRouted: ScopedThreadRef | null;
}): ChatPaneLayout {
  const { layout, nextRouteId, nextRouted, openedFromPane, previousRouteId, previousRouted } =
    input;
  if (nextRouteId === previousRouteId || !isCompanionVisible(layout)) return layout;
  const opensDraftInCompanion =
    openedFromPane === "companion" && nextRouteId?.startsWith("draft:") === true;
  if (!opensDraftInCompanion && !isSameThreadRef(layout.companion, nextRouted)) {
    return layout;
  }
  return {
    ...layout,
    companion: previousRouted,
    companionSide: oppositePaneSide(layout.companionSide),
    focusedPane: "routed",
  };
}

/**
 * Drops a companion the routed pane has taken over, or one whose thread its
 * environment no longer has. Persisted refs outlive the threads they name, and
 * navigating the focused pane onto the companion's thread would otherwise show
 * the same transcript twice.
 *
 * "Gone" is judged per environment, never globally. `knownThreadKeys` spans every
 * connected environment and they connect independently, so a companion living in
 * a slower environment looks absent the moment a faster one reports — and a
 * transient disconnect would evict it for good. Absence only counts once the
 * companion's own environment has threads of its own to be missing from.
 *
 * Keyed by string rather than by ref on purpose. This runs from an effect, and a
 * router selector that rebuilds its result each render would re-run it on every
 * commit — including the one between promoting a pane and the navigation landing,
 * where both panes momentarily name the same thread and this would unsplit them
 * behind the user's back.
 */
export function reconcileCompanion(input: {
  layout: ChatPaneLayout;
  routedKey: string | null;
  knownThreadKeys: ReadonlySet<string>;
}): ChatPaneLayout {
  const { knownThreadKeys, layout, routedKey } = input;
  const { companion } = layout;
  if (!companion) return layout;
  const companionKey = scopedThreadKey(companion);
  if (companionKey === routedKey) return { ...layout, companion: null, focusedPane: "routed" };
  const environmentPrefix = `${companion.environmentId}:`;
  let environmentHasLoaded = false;
  for (const key of knownThreadKeys) {
    if (key.startsWith(environmentPrefix)) {
      environmentHasLoaded = true;
      break;
    }
  }
  if (environmentHasLoaded && !knownThreadKeys.has(companionKey)) {
    return { ...layout, companion: null, focusedPane: "routed" };
  }
  return layout;
}

interface ChatPaneStore extends ChatPaneLayout {
  /**
   * Whether the pane row currently has space for two readable panes. Only the
   * boolean is stored, never the measured width: the width changes every frame
   * of a window or sidebar resize, and each write would re-render the companion's
   * whole ChatView. Not persisted — it is a fact about the current window.
   */
  canSplit: boolean;
  setCanSplit: (canSplit: boolean) => void;
  /** Puts `thread` in the pane on `side`, splitting the inset if it was whole. */
  splitWithThread: (input: {
    routed: ScopedThreadRef | null;
    dropped: ScopedThreadRef;
    side: ChatPaneSide;
  }) => void;
  /** Applies a focus swap the caller has already planned. */
  applyLayout: (layout: ChatPaneLayout) => void;
  closeCompanion: () => void;
  focusPane: (pane: FocusedPane) => void;
  setLeftFraction: (fraction: number, rowWidth: number) => void;
  reconcile: (input: { routedKey: string | null; knownThreadKeys: ReadonlySet<string> }) => void;
}

// Debounced because zustand's persist writes on every `set`, including the no-op
// ones: focus lands on a pointerdown and the divider commits a fraction, and
// neither should mean a synchronous localStorage write.
const chatPaneDebouncedStorage = createDebouncedStorage(
  typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
);

// A pane closed or resized inside the debounce window would otherwise be lost,
// so the close button would read as not having worked after a reload.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    chatPaneDebouncedStorage.flush();
  });
}

export const useChatPaneStore = create<ChatPaneStore>()(
  persist(
    (set) => ({
      ...INITIAL_CHAT_PANE_LAYOUT,
      canSplit: false,

      setCanSplit: (canSplit) =>
        set((state) => (state.canSplit === canSplit ? state : { canSplit })),

      splitWithThread: ({ dropped, routed, side }) =>
        set((state) => planPaneSplit({ dropped, layout: state, routed, side }) ?? state),

      applyLayout: (layout) => set(layout),

      closeCompanion: () => set({ companion: null, focusedPane: "routed" }),

      focusPane: (pane) =>
        set((state) => {
          if (state.focusedPane === pane) return state;
          // Only a live companion can hold focus.
          if (pane === "companion" && state.companion === null) return state;
          return { focusedPane: pane };
        }),

      setLeftFraction: (fraction, rowWidth) =>
        set({ leftFraction: clampPaneFraction(fraction, rowWidth) }),

      reconcile: ({ knownThreadKeys, routedKey }) =>
        set((state) => reconcileCompanion({ knownThreadKeys, layout: state, routedKey })),
    }),
    {
      name: CHAT_PANES_STORAGE_KEY,
      version: CHAT_PANES_STORAGE_VERSION,
      storage: createJSONStorage(() => chatPaneDebouncedStorage),
      partialize: (state): ChatPaneLayout => ({
        companion: state.companion,
        companionSide: state.companionSide,
        focusedPane: state.focusedPane,
        leftFraction: state.leftFraction,
      }),
    },
  ),
);
