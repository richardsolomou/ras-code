import { useEffect } from "react";

import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "./hooks/useSettings";
import { resolvePlanAgentHealPatch } from "./modelSelection";

/**
 * Heals persisted text-generation model selections that still reference the
 * opencode "plan" agent, retired along with plan mode. The pickers no longer
 * offer it, but a stored selection would still dispatch.
 */
export function PlanAgentSelectionHeal() {
  const textGenerationModelSelection = usePrimarySettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const sourceControlWriterModelSelection = usePrimarySettings(
    (settings) => settings.sourceControlWriterModelSelection,
  );
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();

  useEffect(() => {
    // Settings read as defaults until they hydrate; healing before then would
    // write a patch derived from values the user never had.
    if (!settingsHydrated) {
      return;
    }
    const patch = resolvePlanAgentHealPatch({
      textGenerationModelSelection,
      sourceControlWriterModelSelection,
    });
    if (patch) {
      updateSettings(patch);
    }
  }, [
    settingsHydrated,
    textGenerationModelSelection,
    sourceControlWriterModelSelection,
    updateSettings,
  ]);

  return null;
}
