import { describe, expect, it } from "vite-plus/test";

import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_BATCH_BYTES,
  parseRasRelayPublicOrigin,
  type RasRelayFrame,
} from "./rasRelayProtocol.ts";

describe("rasRelayProtocol", () => {
  it("accepts only absolute HTTP origins for relayed requests", () => {
    expect(parseRasRelayPublicOrigin("https://code-tunnels.ras.sh")).toBe(
      "https://code-tunnels.ras.sh",
    );
    expect(parseRasRelayPublicOrigin("https://code-tunnels.ras.sh/path")).toBeNull();
  });

  it("round-trips control and binary frames in one batch", () => {
    const frames = [
      {
        message: {
          type: "http_request_start",
          id: "request-1",
          method: "POST",
          origin: "https://code-tunnels.ras.sh",
          path: "/api/auth/websocket-ticket?source=mobile",
          headers: [["content-type", "application/json"]],
        },
        payload: new Uint8Array(),
      },
      {
        message: { type: "http_request_body", id: "request-1" },
        payload: new Uint8Array([0, 1, 2, 255]),
      },
      {
        message: {
          type: "websocket_message",
          id: "socket-1",
          binary: false,
        },
        payload: new TextEncoder().encode("hello"),
      },
    ] satisfies ReadonlyArray<RasRelayFrame>;

    expect(decodeRasRelayBatch(encodeRasRelayBatch(frames))).toEqual(frames);
  });

  it("rejects malformed and trailing bytes", () => {
    const encoded = encodeRasRelayBatch([
      {
        message: { type: "http_request_end", id: "request-1" },
        payload: new Uint8Array(),
      },
    ]);
    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);

    expect(decodeRasRelayBatch(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeRasRelayBatch(trailing)).toBeNull();
  });

  it("rejects oversized batches before allocation", () => {
    expect(decodeRasRelayBatch(new Uint8Array(RAS_RELAY_MAX_BATCH_BYTES + 1))).toBeNull();
  });

  it("rejects payloads on control-only frames", () => {
    expect(() =>
      encodeRasRelayBatch([
        {
          message: { type: "http_request_end", id: "request-1" },
          payload: new Uint8Array([1]),
        },
      ]),
    ).toThrow("control frame");
  });
});
