export type MobileStageLabel = "Alpha" | "Dev" | "Canary";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Canary";
  return "Alpha";
}
