import { requireOptionalNativeModule } from "expo";

interface RasCodeMarkdownTextSelectionNativeModule {
  readonly installCopySanitizer: (reactTag: number) => void;
}

const nativeModule = requireOptionalNativeModule<RasCodeMarkdownTextSelectionNativeModule>(
  "RasCodeMarkdownTextSelection",
);

export function installMarkdownCopySanitizer(reactTag: number): void {
  nativeModule?.installCopySanitizer(reactTag);
}
