import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { decodeRuntimeConfig } from "./config.ts";

describe("managed relay runtime config", () => {
  it("rejects stale cloudflared runtime state", () => {
    const decoded = decodeRuntimeConfig(
      JSON.stringify({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-id",
      }),
    );

    expect(Option.isNone(decoded)).toBe(true);
  });
});
