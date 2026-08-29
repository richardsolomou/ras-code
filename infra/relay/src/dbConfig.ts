import { relayStageSlug } from "./deploymentConfig.ts";

/**
 * Production owns the base database name. Every other stage gets its own
 * database on the same server, so stages never share tables.
 */
export function relayDatabaseName(stage: string, baseName: string): string {
  return stage === "prod" ? baseName : `${baseName}-${relayStageSlug(stage)}`;
}
