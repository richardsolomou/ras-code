import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { buildFromTemplateMock, setApplicationMenuMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(),
  setApplicationMenuMock: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

const TestLayer = ElectronMenu.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    setApplicationMenuMock.mockReset();
  });

  it.effect("defers popupTemplate side effects until the returned Effect runs", () =>
    Effect.gen(function* () {
      const popupMock = vi.fn();
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const popup = electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: "Copy" }],
      });

      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
      assert.equal(popupMock.mock.calls.length, 0);

      yield* popup;

      assert.equal(buildFromTemplateMock.mock.calls.length, 1);
      assert.equal(popupMock.mock.calls.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves application-menu failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("application menu build failed");
      buildFromTemplateMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.setApplicationMenu([{ label: "File" }, { label: "Edit" }]),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "set-application-menu");
        assert.equal(error.platform, "linux");
        assert.isNull(error.windowId);
        assert.equal(error.itemCount, 2);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves popup-template failures with window context", () =>
    Effect.gen(function* () {
      const cause = new Error("popup failed");
      buildFromTemplateMock.mockReturnValueOnce({
        popup: () => {
          throw cause;
        },
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.popupTemplate({
          window: { id: 41 } as Electron.BrowserWindow,
          template: [{ label: "Copy" }],
        }),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "popup-template");
        assert.equal(error.windowId, 41);
        assert.equal(error.itemCount, 1);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});
