/**
 * Side-by-side chat panes.
 *
 * The focused pane is always the routed thread, so this store only holds the
 * companion beside it. The URL stays the single source of truth for what has
 * focus, and focusing the companion swaps the two rather than introducing a
 * second notion of "the current thread"; `companionSide` flips with that swap
 * so neither pane moves on screen.
 */
import { scopedThreadKey } from "@ras-code/client-runtime/environment";
import type { ScopedThreadRef } from "@ras-code/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

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

export const INITIAL_CHAT_PANE_LAYOUT: ChatPaneLayout = {
  companion: null,
  companionSide: "right",
  focusedPane: "routed",
  leftFraction: 0.5,
};

/** The thread the user is working in, which is what the sidebar marks active. */
export function selectFocusedThread(
  layout: ChatPaneLayout,
  routed: ScopedThreadRef | null,
): ScopedThreadRef | null {
  if (layout.focusedPane === "companion" && layout.companion) return layout.companion;
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
  return { ...layout, companion: dropped, companionSide: side, focusedPane: "routed" };
}

export interface PaneFocusPlan {
  layout: ChatPaneLayout;
  /** The thread the router must move to, since the routed pane is the focused one. */
  navigateTo: ScopedThreadRef;
}

/**
 * Focus moving to the companion. The two threads trade places and the side flips
 * with them, so focus changes without either pane sliding across.
 *
 * A route with no server thread of its own — a draft, or the landing page — has
 * nothing to hand back, so the companion is adopted as the only pane. The draft
 * is still in the sidebar afterwards; this navigates away from it exactly as
 * clicking its row would.
 */
export function planPaneFocusChange(
  layout: ChatPaneLayout,
  routed: ScopedThreadRef | null,
): PaneFocusPlan | null {
  if (!layout.companion) return null;
  if (!routed) {
    return {
      layout: { ...layout, companion: null, focusedPane: "routed" },
      navigateTo: layout.companion,
    };
  }
  return {
    layout: {
      ...layout,
      companion: routed,
      companionSide: oppositePaneSide(layout.companionSide),
      focusedPane: "routed",
    },
    navigateTo: layout.companion,
  };
}

/**
 * Whether a change of routed thread should collapse the split.
 *
 * Clicking a thread — in the sidebar, the palette, a notification, a link — is a
 * navigation, not a pane operation: it takes you to that thread, on its own.
 * Re-targeting one of two panes instead leaves the user working out which pane a
 * click will land in, which is exactly the question panes should not raise.
 *
 * Promoting the companion is the one navigation that keeps both panes, and it is
 * recognisable without a flag: it moves the route onto the thread the companion
 * was already showing, so the pane the route just left is the companion.
 */
export function shouldCollapseOnNavigation(input: {
  previousRoutedKey: string | null;
  nextRoutedKey: string | null;
  companionKey: string | null;
}): boolean {
  const { companionKey, nextRoutedKey, previousRoutedKey } = input;
  if (companionKey === null) return false;
  if (nextRoutedKey === previousRoutedKey) return false;
  if (previousRoutedKey === companionKey) return false;
  if (nextRoutedKey === companionKey) return false;
  return true;
}

/**
 * Drops a companion the routed pane has taken over, or one whose thread the
 * environment no longer has. Persisted refs outlive the threads they name, and
 * navigating the focused pane onto the companion's thread would otherwise show
 * the same transcript twice.
 *
 * An empty `knownThreadKeys` means "not loaded yet", never "no threads exist".
 * The list is empty on every boot, and the environment-bootstrap flag reads true
 * before any environment has connected, so treating empty as authoritative
 * evicts a restored companion on the first render after a reload.
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
  if (knownThreadKeys.size > 0 && !knownThreadKeys.has(companionKey)) {
    return { ...layout, companion: null, focusedPane: "routed" };
  }
  return layout;
}

interface ChatPaneStore extends ChatPaneLayout {
  /**
   * Measured width of the pane row. Not persisted — it is a fact about the
   * current window, and it lives here so the sidebar can hide a split action
   * the inset has no room for without measuring the inset itself.
   */
  rowWidth: number;
  setRowWidth: (width: number) => void;
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
  setLeftFraction: (fraction: number) => void;
  reconcile: (input: { routedKey: string | null; knownThreadKeys: ReadonlySet<string> }) => void;
}

export const useChatPaneStore = create<ChatPaneStore>()(
  persist(
    (set) => ({
      ...INITIAL_CHAT_PANE_LAYOUT,
      rowWidth: 0,

      setRowWidth: (width) =>
        set((state) => (state.rowWidth === width ? state : { rowWidth: width })),

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

      setLeftFraction: (fraction) =>
        set((state) => ({ leftFraction: clampPaneFraction(fraction, state.rowWidth) })),

      reconcile: ({ knownThreadKeys, routedKey }) =>
        set((state) => reconcileCompanion({ knownThreadKeys, layout: state, routedKey })),
    }),
    {
      name: CHAT_PANES_STORAGE_KEY,
      version: CHAT_PANES_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): ChatPaneLayout => ({
        companion: state.companion,
        companionSide: state.companionSide,
        focusedPane: state.focusedPane,
        leftFraction: state.leftFraction,
      }),
    },
  ),
);
