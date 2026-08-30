import type { EnvironmentId } from "@ras-code/contracts";

export interface SettingsEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Device tab order: the device serving this client first, then by label. */
export function buildSettingsEnvironmentOptions<T extends SettingsEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) {
      return leftIsPrimary ? -1 : 1;
    }
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

/**
 * The device whose server settings the settings UI reads and writes.
 *
 * Server settings live in each environment's `settings.json`, so every one of
 * those rows names a device even when only one is connected.
 *
 * An explicit pick wins while that device is in the catalog, so a device that
 * drops out and reconnects gets its selection back rather than having it
 * erased. Otherwise the client anchors to the device that serves it; the
 * hosted app has no same-origin backend, so it follows the environment it is
 * working in, and failing that the first device in tab order.
 */
export function resolveSettingsEnvironmentId(input: {
  readonly options: ReadonlyArray<SettingsEnvironmentOptionLike>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const isConnected = (environmentId: EnvironmentId | null) =>
    environmentId !== null &&
    input.options.some((environment) => environment.environmentId === environmentId);

  if (isConnected(input.selectedEnvironmentId)) return input.selectedEnvironmentId;
  if (isConnected(input.primaryEnvironmentId)) return input.primaryEnvironmentId;
  if (isConnected(input.activeEnvironmentId)) return input.activeEnvironmentId;
  return input.options[0]?.environmentId ?? null;
}
