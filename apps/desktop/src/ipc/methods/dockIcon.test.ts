import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import { setDockIcon } from "./dockIcon.ts";

function makeElectronAppLayer(painted: Array<string>) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("RAS Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    setDockIconImage: (pngDataUrl) =>
      Effect.sync(() => {
        painted.push(pngDataUrl);
        return true;
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const invoke = (pngDataUrl: string, painted: Array<string>) =>
  setDockIcon.handler(pngDataUrl).pipe(Effect.provide(makeElectronAppLayer(painted)));

describe("dock icon IPC method", () => {
  it.effect("paints the dock tile from a PNG data URL", () =>
    Effect.gen(function* () {
      const painted: Array<string> = [];
      const image = "data:image/png;base64,AAAA";

      assert.strictEqual(yield* invoke(image, painted), true);
      assert.deepEqual(painted, [image]);
    }),
  );

  it.effect("refuses payloads that are not PNG data URLs", () =>
    Effect.gen(function* () {
      const painted: Array<string> = [];

      assert.strictEqual(yield* invoke("data:image/svg+xml;base64,AAAA", painted), false);
      assert.deepEqual(painted, []);
    }),
  );

  it.effect("refuses oversized images", () =>
    Effect.gen(function* () {
      const painted: Array<string> = [];
      const image = `data:image/png;base64,${"A".repeat(4_000_000)}`;

      assert.strictEqual(yield* invoke(image, painted), false);
      assert.deepEqual(painted, []);
    }),
  );
});
