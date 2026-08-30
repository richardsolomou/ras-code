import { createContext, useContext } from "react";

/**
 * Whether the ChatView reading this is the pane the user is working in, and so
 * owns the window-level shortcuts and the automatic composer focus.
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
