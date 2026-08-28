import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Whether the user is actually looking at the app. A window can hold focus
 * while its tab is hidden behind another, so both signals have to agree.
 */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === "visible" && document.hasFocus(),
    () => true,
  );
}
