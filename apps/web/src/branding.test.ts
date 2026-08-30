import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "RAS Code",
            stageLabel: "Canary",
            displayName: "RAS Code (Canary)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("RAS Code");
    expect(branding.APP_STAGE_LABEL).toBe("Canary");
    expect(branding.APP_DISPLAY_NAME).toBe("RAS Code (Canary)");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "canary");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("canary");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Canary");
    expect(branding.APP_STAGE_LABEL).toBe("Canary");
    expect(branding.APP_DISPLAY_NAME).toBe("RAS Code (Canary)");
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("RAS Code");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it("returns Canary for canary primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-canary.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Canary");
  });

  it("updates the display name for canary primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "RAS Code",
        fallbackDisplayName: "RAS Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-canary.20260616.12",
      }),
    ).toBe("RAS Code (Canary)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "RAS Code",
        fallbackDisplayName: "RAS Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("RAS Code (Alpha)");
  });

  it("keeps the fallback display name for malformed canary primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "RAS Code",
        fallbackDisplayName: "RAS Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-canary.20260616",
      }),
    ).toBe("RAS Code (Alpha)");
  });
});
