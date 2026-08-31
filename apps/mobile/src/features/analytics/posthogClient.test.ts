import type { PostHog } from "posthog-react-native";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePostHogScreen, setPostHogClient, transitionPostHogUser } from "./posthogClient";

afterEach(() => {
  setPostHogClient(null);
});

describe("PostHog client bridge", () => {
  it("identifies the signed-in account", () => {
    const identify = vi.fn();
    setPostHogClient({ identify } as unknown as PostHog);

    transitionPostHogUser(null, "user_123");

    expect(identify).toHaveBeenCalledWith("user_123");
  });

  it("separates account switches and restores release properties", () => {
    const calls: string[] = [];
    const reset = vi.fn(() => calls.push("reset"));
    const register = vi.fn(() => calls.push("register"));
    const identify = vi.fn(() => calls.push("identify"));
    const releaseProperties = { expo_channel: "production" };
    setPostHogClient({ identify, register, reset } as unknown as PostHog, releaseProperties);

    transitionPostHogUser("user_123", "user_456");

    expect({ calls, identified: identify.mock.calls, registered: register.mock.calls }).toEqual({
      calls: ["reset", "register", "identify"],
      identified: [["user_456"]],
      registered: [[releaseProperties]],
    });
  });

  it("resets the account identity on sign-out", () => {
    const reset = vi.fn();
    setPostHogClient({ reset } as unknown as PostHog);

    transitionPostHogUser("user_123", null);

    expect(reset).toHaveBeenCalledOnce();
  });

  it("captures stable screen names", () => {
    const screen = vi.fn();
    setPostHogClient({ screen } as unknown as PostHog);

    capturePostHogScreen("SettingsSheet");

    expect(screen).toHaveBeenCalledWith("SettingsSheet");
  });

  it("does nothing when PostHog is not configured", () => {
    expect(() => capturePostHogScreen("Home")).not.toThrow();
  });
});
