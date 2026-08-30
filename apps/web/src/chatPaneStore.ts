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
 * Keyed off the route target rather than the thread it resolves to, because a
 * draft promoting in place resolves from no thread to a real one without the
 * route moving at all — collapsing there would delete the companion the moment
 * the user sends the prompt they opened it for.
 *
 * Promoting the companion is the one real navigation that keeps both panes, and
 * it is recognisable without a flag: it moves the route onto the thread the
 * companion was already showing, so the pane the route just left is the
 * companion.
 */
export function shouldCollapseOnNavigation(input: {
  previousRouteId: string | null;
  nextRouteId: string | null;
  previousRoutedKey: string | null;
  companionKey: string | null;
}): boolean {
  const { companionKey, nextRouteId, previousRouteId, previousRoutedKey } = input;
  if (companionKey === null) return false;
  if (nextRouteId === previousRouteId) return false;
  if (previousRoutedKey === companionKey) return false;
  return true;
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
