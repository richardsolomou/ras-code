import { SymbolView as ExpoSymbolView, type SymbolViewProps } from "expo-symbols";

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

/**
 * Keep the iOS implementation isolated from the Android Tabler fallback so
 * Metro does not initialize the icon package when iOS renders SF Symbols.
 */
export function SymbolView(props: SymbolViewProps) {
  return <ExpoSymbolView {...props} />;
}
