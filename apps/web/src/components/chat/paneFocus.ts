import { createContext, useContext } from "react";

export const PANE_DEFAULT_FOCUS_SELECTOR = '[data-testid="composer-editor"]';
const PANE_FOCUSABLE_SELECTOR =
  'a[href],button,input,select,textarea,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

export function restorePaneFocus(root: HTMLElement, remembered: HTMLElement | null): boolean {
  const target =
    remembered?.isConnected && root.contains(remembered)
      ? remembered
      : root.querySelector<HTMLElement>(PANE_DEFAULT_FOCUS_SELECTOR);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/**
 * Whether the pane holds live selected text. Moving focus collapses it, so an
 * implicit restore has to stand down: a drag that selects transcript text ends
 * in a click, and the user wants the highlight, not the composer caret.
 */
export function paneHasTextSelection(root: HTMLElement, selection: Selection | null): boolean {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false;
  return root.contains(selection.getRangeAt(0).commonAncestorContainer);
}

export function restorePaneFocusAfterClick(
  root: HTMLElement,
  target: EventTarget | null,
  activeElement: Element | null,
  remembered: HTMLElement | null,
  selection: Selection | null,
): boolean {
  if (
    target !== null &&
    typeof target === "object" &&
    "closest" in target &&
    typeof target.closest === "function" &&
    target.closest(PANE_FOCUSABLE_SELECTOR) !== null
  ) {
    return false;
  }
  if (root.contains(activeElement)) return false;
  if (paneHasTextSelection(root, selection)) return false;
  return restorePaneFocus(root, remembered);
}

let paneFocusRestorer: (() => boolean) | null = null;

export function registerPaneFocusRestorer(restorer: () => boolean): () => void {
  paneFocusRestorer = restorer;
  return () => {
    if (paneFocusRestorer === restorer) paneFocusRestorer = null;
  };
}

export function restoreActivePaneFocus(): boolean {
  return paneFocusRestorer?.() ?? false;
}

/**
 * Whether the ChatView reading this is the pane the user is working in, and so
 * owns pane-scoped shortcuts.
 *
 * Focus is client state rather than the route — a click moves it, and the URL
 * stays where it is. Defaults to true, which is every ChatView outside a split:
 * those behave exactly as they did before panes existed.
 */
const PaneFocusContext = createContext(true);

export const PaneFocusProvider = PaneFocusContext.Provider;

export function useIsFocusedPane(): boolean {
  return useContext(PaneFocusContext);
}

/**
 * Whether this ChatView is the routed pane — the one whose thread changes as the
 * user navigates.
 *
 * Distinct from focus, which a click moves. Only the routed pane benefits from
 * keeping other threads' terminals mounted, because only it can navigate back to
 * them; a companion holds one thread until it is explicitly replaced. Defaults to
 * true, so a ChatView outside a split retains exactly as it did before.
 */
const PaneIsRoutedContext = createContext(true);

export const PaneIsRoutedProvider = PaneIsRoutedContext.Provider;

export function useIsRoutedPane(): boolean {
  return useContext(PaneIsRoutedContext);
}
