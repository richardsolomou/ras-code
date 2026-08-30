import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveNotificationIcon } from "./ElectronNotification.ts";

describe("resolveNotificationIcon", () => {
  it("prefers the macOS bundle icon", () => {
    assert.equal(
      resolveNotificationIcon({
        ico: Option.some("/app/icon.ico"),
        icns: Option.some("/app/icon.icns"),
        png: Option.some("/app/icon.png"),
      }),
      "/app/icon.icns",
    );
  });

  it("falls back to a PNG icon", () => {
    assert.equal(
      resolveNotificationIcon({
        ico: Option.some("/app/icon.ico"),
        icns: Option.none(),
        png: Option.some("/app/icon.png"),
      }),
      "/app/icon.png",
    );
  });
});
