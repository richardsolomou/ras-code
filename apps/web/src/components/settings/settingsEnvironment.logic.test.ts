import { EnvironmentId } from "@ras-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSettingsEnvironmentOptions,
  resolveSettingsEnvironmentId,
} from "./settingsEnvironment.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("settings environment selection", () => {
  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildSettingsEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildSettingsEnvironmentOptions(environments, primaryId);

    expect(
      resolveSettingsEnvironmentId({
        options,
        selectedEnvironmentId: sshId,
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: relayId,
      }),
    ).toBe(sshId);
    expect(
      resolveSettingsEnvironmentId({
        options: options.filter((environment) => environment.environmentId !== sshId),
        selectedEnvironmentId: sshId,
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: relayId,
      }),
    ).toBe(primaryId);
    expect(
      resolveSettingsEnvironmentId({
        options: options.slice(1),
        selectedEnvironmentId: primaryId,
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: null,
      }),
    ).toBe(relayId);
    expect(
      resolveSettingsEnvironmentId({
        options: [],
        selectedEnvironmentId: null,
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: primaryId,
      }),
    ).toBeNull();
  });

  it("anchors to the active environment when no device serves this client", () => {
    // The hosted app has no same-origin backend, so without this it would show
    // and write nothing for every server-backed setting.
    const options = buildSettingsEnvironmentOptions(
      environments.filter((environment) => environment.environmentId !== primaryId),
      null,
    );

    expect(
      resolveSettingsEnvironmentId({
        options,
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: sshId,
      }),
    ).toBe(sshId);
    expect(
      resolveSettingsEnvironmentId({
        options,
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
      }),
    ).toBe(relayId);
  });
});
