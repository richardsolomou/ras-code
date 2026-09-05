import type { DesktopUpdateChannel } from "@t3tools/contracts";

const CANARY_VERSION_PATTERN = /-canary\.\d{8}\.\d+$/;

export function isCanaryDesktopVersion(version: string): boolean {
  return CANARY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isCanaryDesktopVersion(appVersion) ? "canary" : "latest";
}
