import { DEFAULT_HOSTED_APP_URL, hostedAppUrlFor } from "@ras-code/shared/connectAuth";

import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "canary";

export function configuredHostedAppUrl(): string {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || DEFAULT_HOSTED_APP_URL;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "canary" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url: URL = new URL(window.location.href)): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && url.origin === hostedOrigin;
}

/** Path a hosted pairing link lands on, including the hosted app's prefix. */
export function hostedPairingPath(): string {
  return hostedAppUrlFor(configuredHostedAppUrl(), "pair").pathname;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = hostedAppUrlFor(configuredHostedAppUrl(), "pair");
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = hostedAppUrlFor(configuredHostedAppUrl(), "__ras-code/channel");
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
