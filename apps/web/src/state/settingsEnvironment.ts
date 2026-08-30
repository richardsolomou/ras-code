/**
 * The device the settings UI is scoped to.
 *
 * Client settings are this browser's own, but server settings live in each
 * environment's `settings.json`, so every settings surface that writes one has
 * to name a device. The pick is shared across settings pages — choosing a
 * device under Providers keeps General and Source Control pointed at the same
 * machine — and it is the only way the hosted app (which has no same-origin
 * backend of its own) reaches any server settings at all.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig, ServerProvider } from "@ras-code/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import {
  buildSettingsEnvironmentOptions,
  resolveSettingsEnvironmentId,
} from "../components/settings/settingsEnvironment.logic";
import { useActiveEnvironmentId } from "./entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "./environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "./server";

/**
 * Raw user intent. The effective device is re-derived on every render so a
 * device that leaves the catalog falls back without erasing the pick.
 */
export const settingsEnvironmentSelectionAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-settings-environment-selection"),
);

export interface SettingsEnvironmentScope {
  /** Connected devices, in tab order. */
  readonly options: ReadonlyArray<EnvironmentPresentation>;
  readonly environmentId: EnvironmentId | null;
  readonly environment: EnvironmentPresentation | null;
  /** False while the connection catalog is still loading. */
  readonly isReady: boolean;
  readonly select: (environmentId: EnvironmentId) => void;
}

export function useSettingsEnvironmentScope(): SettingsEnvironmentScope {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const selectedEnvironmentId = useAtomValue(settingsEnvironmentSelectionAtom);
  const select = useAtomSet(settingsEnvironmentSelectionAtom);

  const options = useMemo(
    () => buildSettingsEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  const environmentId = resolveSettingsEnvironmentId({
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
    activeEnvironmentId,
  });
  const environment =
    options.find((candidate) => candidate.environmentId === environmentId) ?? null;

  return { options, environmentId, environment, isReady, select };
}

export function useSettingsEnvironmentId(): EnvironmentId | null {
  return useSettingsEnvironmentScope().environmentId;
}

export function useSettingsEnvironmentConfig(): ServerConfig | null {
  return useAtomValue(serverEnvironment.configValueAtom(useSettingsEnvironmentId()));
}

export function useSettingsEnvironmentProviders(): ReadonlyArray<ServerProvider> {
  return useSettingsEnvironmentConfig()?.providers ?? EMPTY_SERVER_PROVIDERS;
}
