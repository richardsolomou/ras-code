import { createContext, useContext } from "react";

/**
 * Whether the ChatView reading this owns the window-level shortcuts and the
 * automatic composer focus.
 *
 * Focus follows the router: the routed pane is the focused one, so a companion
 * pane reads false and leaves the global keys alone. Defaults to true, which is
 * every ChatView outside a split — those behave exactly as they did before panes
 * existed.
 */
const PaneFocusContext = createContext(true);

export const PaneFocusProvider = PaneFocusContext.Provider;

export function useIsFocusedPane(): boolean {
  return useContext(PaneFocusContext);
}
