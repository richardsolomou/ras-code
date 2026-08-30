import {
  POSTHOG_DEV_PROXY_PATH,
  POSTHOG_MANAGED_PROXY_HOST,
  POSTHOG_PROJECT_TOKEN,
} from "@ras-code/shared/posthog";
import type { CaptureResult, PostHog } from "posthog-js";

import { LRUCache } from "../lib/lruCache";

const TELEMETRY_ORIGIN = "https://app.ras-code.local";
const PUBLIC_ROUTE_SEGMENTS = new Set(["callback", "connect", "pair"]);
const MAX_REMEMBERED_ROUTES = 100;
const MAX_REMEMBERED_ROUTE_BYTES = 64 * 1024;

let clientPromise: Promise<PostHog> | null = null;
let client: PostHog | null = null;
let desiredEnabled = false;
let capturingEnabled = false;
let lastPageview: string | null = null;
const knownTelemetryPaths = new LRUCache<string>(MAX_REMEMBERED_ROUTES, MAX_REMEMBERED_ROUTE_BYTES);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function basename(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  return path.split(/[\\/]/).at(-1);
}

function parsePathname(value: string): string {
  try {
    return new URL(value, TELEMETRY_ORIGIN).pathname;
  } catch {
    return "/";
  }
}

export function normalizeTelemetryPath(routePattern: string): string {
  const segments = routePattern
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("$") ? ":id" : segment));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function fallbackTelemetryPath(value: string): string {
  const segments = parsePathname(value)
    .split("/")
    .filter(Boolean)
    .map((segment) => (PUBLIC_ROUTE_SEGMENTS.has(segment) ? segment : ":id"));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function rememberTelemetryPath(pathname: string, routePattern: string): string {
  const sourcePath = parsePathname(pathname);
  const telemetryPath = normalizeTelemetryPath(routePattern);
  knownTelemetryPaths.set(
    sourcePath,
    telemetryPath,
    (sourcePath.length + telemetryPath.length) * 2,
  );
  return telemetryPath;
}

function telemetryPathForUrl(value: string): string {
  const pathname = parsePathname(value);
  return knownTelemetryPaths.get(pathname) ?? fallbackTelemetryPath(pathname);
}

function sanitizeUrlBearingData(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeUrlBearingData(entry, parentKey));
  const record = asRecord(value);
  if (record === undefined) {
    if (
      typeof value === "string" &&
      parentKey !== undefined &&
      (parentKey.toLowerCase().includes("url") || ["href", "src"].includes(parentKey.toLowerCase()))
    ) {
      return `${TELEMETRY_ORIGIN}${telemetryPathForUrl(value)}`;
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, sanitizeUrlBearingData(entry, key)]),
  );
}

function sanitizeReplaySnapshot(value: unknown): unknown {
  return Array.isArray(value) || asRecord(value) !== undefined
    ? sanitizeUrlBearingData(value)
    : undefined;
}

function sanitizedCurrentUrl(value: unknown, pathname: unknown): string {
  const source = typeof value === "string" ? value : typeof pathname === "string" ? pathname : "/";
  return `${TELEMETRY_ORIGIN}${telemetryPathForUrl(source)}`;
}

function sanitizeAutocaptureElements(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const element = asRecord(entry) ?? {};
    return Object.fromEntries(
      ["tag_name", "nth_child", "nth_of_type"].flatMap((key) =>
        element[key] === undefined ? [] : [[key, element[key]]],
      ),
    );
  });
}

function sanitizeExceptionList(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const exception = asRecord(entry) ?? {};
    const stacktrace = asRecord(exception.stacktrace);
    const frames = stacktrace?.frames;
    return {
      type: exception.type,
      value: "Redacted exception",
      ...(Array.isArray(frames)
        ? {
            stacktrace: {
              type: "raw",
              frames: frames.map((frameValue) => {
                const frame = asRecord(frameValue) ?? {};
                return Object.fromEntries(
                  ["function", "lineno", "colno", "in_app", "chunk_id"]
                    .flatMap((key) => (frame[key] === undefined ? [] : [[key, frame[key]]]))
                    .concat([
                      ["filename", basename(frame.filename ?? frame.abs_path) ?? "unknown"],
                    ]),
                );
              }),
            },
          }
        : {}),
    };
  });
}

function sanitizeHeatmapData(value: unknown): Record<string, unknown[]> | undefined {
  const heatmapData = asRecord(value);
  if (heatmapData === undefined) return undefined;
  const sanitized: Record<string, unknown[]> = {};
  for (const [url, points] of Object.entries(heatmapData)) {
    if (!Array.isArray(points)) continue;
    const normalizedUrl = sanitizedCurrentUrl(url, undefined);
    sanitized[normalizedUrl] = [
      ...(sanitized[normalizedUrl] ?? []),
      ...points.map((pointValue) => {
        const point = asRecord(pointValue) ?? {};
        return Object.fromEntries(
          ["x", "y", "target_fixed", "type"].flatMap((key) =>
            point[key] === undefined ? [] : [[key, point[key]]],
          ),
        );
      }),
    ];
  }
  return sanitized;
}

export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (event === null) return null;
  const {
    $elements_chain: _elementsChain,
    $el_text: _elementText,
    $exception_steps: _exceptionSteps,
    $external_click_url: _externalClickUrl,
    $prev_pageview_pathname: _previousPageviewPathname,
    $referrer: _referrer,
    $referring_domain: _referringDomain,
    ...properties
  } = event.properties;
  const pathname = telemetryPathForUrl(
    typeof properties.$current_url === "string"
      ? properties.$current_url
      : typeof properties.$pathname === "string"
        ? properties.$pathname
        : "/",
  );
  const sanitizedProperties =
    event.event === "$web_vitals"
      ? (asRecord(sanitizeUrlBearingData(properties)) ?? {})
      : properties;
  const safeProperties = {
    ...sanitizedProperties,
    $geoip_disable: true,
    $current_url: sanitizedCurrentUrl(properties.$current_url, properties.$pathname),
    $pathname: pathname,
    $host: "app.ras-code.local",
    ...(event.event === "$autocapture"
      ? { $elements: sanitizeAutocaptureElements(properties.$elements) }
      : {}),
    ...(event.event === "$exception"
      ? {
          $exception_message: "Redacted exception",
          $exception_list: sanitizeExceptionList(properties.$exception_list),
        }
      : {}),
    ...(event.event === "$$heatmap"
      ? { $heatmap_data: sanitizeHeatmapData(properties.$heatmap_data) }
      : {}),
    ...(event.event === "$snapshot"
      ? { $snapshot_data: sanitizeReplaySnapshot(properties.$snapshot_data) }
      : {}),
  };
  if (event.event === "$snapshot" && safeProperties.$snapshot_data === undefined) return null;
  return { ...event, properties: safeProperties };
}

async function loadClient(): Promise<PostHog> {
  if (clientPromise !== null) return clientPromise;
  clientPromise = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(POSTHOG_PROJECT_TOKEN, {
      api_host: import.meta.env.DEV ? POSTHOG_DEV_PROXY_PATH : POSTHOG_MANAGED_PROXY_HOST,
      ui_host: "https://us.posthog.com",
      defaults: "2026-08-30",
      autocapture: true,
      capture_pageview: false,
      capture_pageleave: false,
      capture_heatmaps: true,
      capture_exceptions: { capture_console_errors: false },
      capture_performance: { web_vitals: true, web_vitals_attribution: false },
      disable_surveys: true,
      enable_recording_console_log: false,
      mask_all_element_attributes: true,
      mask_all_text: true,
      mask_personal_data_properties: true,
      custom_personal_data_properties: ["token", "code", "state"],
      opt_out_capturing_by_default: true,
      person_profiles: "never",
      session_recording: {
        blockSelector: ".ph-no-capture",
        captureJsonLd: false,
        collectFonts: false,
        compress_events: false,
        maskAllElementAttributes: true,
        maskAllInputs: true,
        maskCapturedNetworkRequestFn: () => null,
        recordBody: false,
        recordHeaders: false,
      },
      before_send: sanitizePostHogEvent,
    });
    client = posthog;
    return posthog;
  });
  return clientPromise;
}

export async function configurePostHogBrowserTelemetry(
  enabled: boolean,
  pathname: string,
  routePattern: string,
): Promise<void> {
  desiredEnabled = enabled;
  if (!enabled) {
    lastPageview = null;
    knownTelemetryPaths.clear();
    if (capturingEnabled) {
      client?.stopSessionRecording();
      client?.opt_out_capturing();
      capturingEnabled = false;
    }
    return;
  }

  const normalizedPath = rememberTelemetryPath(pathname, routePattern);
  const posthog = await loadClient();
  if (!desiredEnabled) {
    posthog.stopSessionRecording();
    posthog.opt_out_capturing();
    capturingEnabled = false;
    return;
  }
  if (!capturingEnabled) {
    posthog.opt_in_capturing({ captureEventName: false });
    posthog.startSessionRecording();
    capturingEnabled = true;
  }
  if (lastPageview === normalizedPath) return;
  lastPageview = normalizedPath;
  posthog.capture("$pageview", {
    $current_url: `${TELEMETRY_ORIGIN}${normalizedPath}`,
    $pathname: normalizedPath,
  });
}

export function capturePostHogBrowserException(error: unknown): void {
  if (!desiredEnabled || client === null) return;
  client.captureException(error, { operation: "web.route" });
}
