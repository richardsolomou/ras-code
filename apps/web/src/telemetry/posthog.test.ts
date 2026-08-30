import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { normalizeTelemetryPath, sanitizePostHogEvent } from "./posthog";

describe("PostHog browser telemetry", () => {
  it.each([
    ["/", "/"],
    ["/settings/providers", "/settings/providers"],
    ["/pair?token=private", "/pair"],
    ["/environment-secret/thread-secret", "/:id/:id"],
    ["/environment-secret/draft/draft-secret", "/:id/draft/:id"],
  ])("normalizes %s without identifiers", (path, expected) => {
    expect(normalizeTelemetryPath(path)).toBe(expected);
  });

  it("removes URLs and element content from autocapture events", () => {
    const sanitized = sanitizePostHogEvent({
      uuid: "event-id",
      event: "$autocapture",
      properties: {
        $current_url: "https://code.ras.sh/pair?token=phx_secret",
        $pathname: "/pair",
        $referrer: "https://example.com/private",
        $elements_chain: "button.private-text",
        $el_text: "private prompt",
        $external_click_url: "https://example.com/private?token=phx_secret",
        $elements: [
          {
            tag_name: "button",
            nth_child: 2,
            attr__href: "/pair?token=phx_secret",
            $el_text: "private prompt",
          },
        ],
      },
    });

    const capturedText = NodeUtil.inspect(sanitized, { depth: null });
    expect(capturedText).not.toContain("phx_secret");
    expect(capturedText).not.toContain("private prompt");
    expect(capturedText).not.toContain("example.com");
    expect(capturedText).not.toContain("$external_click_url");
    expect(sanitized?.properties.$current_url).toBe("https://app.ras-code.local/pair");
    expect(sanitized?.properties.$elements).toEqual([{ tag_name: "button", nth_child: 2 }]);
  });

  it("redacts browser exception content while retaining grouping fields", () => {
    const sanitized = sanitizePostHogEvent({
      uuid: "event-id",
      event: "$exception",
      properties: {
        $current_url: "file:///Users/richard/private-project/index.html#thread-secret",
        $exception_list: [
          {
            type: "Error",
            value: "private prompt phx_secret",
            stacktrace: {
              type: "raw",
              frames: [
                {
                  filename: "/Users/richard/private-project/app.tsx",
                  abs_path: "/Users/richard/private-project/app.tsx",
                  lineno: 12,
                  colno: 4,
                  context_line: "throw new Error('phx_secret')",
                  chunk_id: "public-chunk-id",
                },
              ],
            },
          },
        ],
      },
    });

    const capturedText = NodeUtil.inspect(sanitized, { depth: null });
    expect(capturedText).not.toContain("phx_secret");
    expect(capturedText).not.toContain("/Users/richard");
    expect(capturedText).toContain("Redacted exception");
    expect(capturedText).toContain("app.tsx");
    expect(capturedText).toContain("public-chunk-id");
  });

  it("normalizes heatmap URLs and keeps only pointer data", () => {
    const sanitized = sanitizePostHogEvent({
      uuid: "event-id",
      event: "$$heatmap",
      properties: {
        $heatmap_data: {
          "https://code.ras.sh/environment-secret/thread-secret?token=phx_secret": [
            {
              x: 120,
              y: 80,
              target_fixed: false,
              type: "click",
              content: "private prompt",
            },
          ],
        },
      },
    });

    const capturedText = NodeUtil.inspect(sanitized, { depth: null });
    expect(capturedText).not.toContain("phx_secret");
    expect(capturedText).not.toContain("private prompt");
    expect(sanitized?.properties.$heatmap_data).toEqual({
      "https://app.ras-code.local/:id/:id": [{ x: 120, y: 80, target_fixed: false, type: "click" }],
    });
  });
});
