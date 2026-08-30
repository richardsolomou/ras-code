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
