/** Non-shipping build markers. A release build has no stage label. */
export type MobileStageLabel = "Dev" | "Canary";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Canary";
  return null;
}
