import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getHedgehogModeAssetsUrl,
  mountHedgehogMode,
  type HedgehogModeMountOptions,
} from "./HedgehogMode";

class FakeCanvas extends EventTarget {}

function makeGame(input?: { readonly renderError?: Error }) {
  const canvas = new FakeCanvas();
  const sprite = { updateSprite: vi.fn() };
  const game = {
    app: {
      canvas,
      renderer: { context: { isLost: false } },
    },
    destroy: vi.fn(),
    getAllHedgehogs: () => [sprite],
    render: input?.renderError
      ? vi.fn().mockRejectedValue(input.renderError)
      : vi.fn().mockResolvedValue(undefined),
  };
  let constructorOptions:
    | (HedgehogModeMountOptions & { onQuit: (activeGame: typeof game) => void })
    | undefined;
  function FakeHedgehogMode(
    this: unknown,
    options: HedgehogModeMountOptions & { onQuit: (activeGame: typeof game) => void },
  ) {
    constructorOptions = options;
    return game;
  }
  const load = vi.fn(async () => ({
    HedgeHogMode: FakeHedgehogMode,
  }));
  return { canvas, constructorOptions: () => constructorOptions, game, load, sprite };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hedgehog mode", () => {
  it("resolves assets beneath the application base path", () => {
    expect(getHedgehogModeAssetsUrl("/app/", "https://ras-code.test")).toBe(
      "https://ras-code.test/app/hedgehog-mode",
    );
  });

  it("mounts, monitors, and destroys the game", async () => {
    const fixture = makeGame();
    const onContextLost = vi.fn();
    const container = {} as HTMLDivElement;
    const handle = await mountHedgehogMode(
      container,
      {
        assetsUrl: "https://ras-code.test/hedgehog-mode",
        onContextLost,
        onQuit: vi.fn(),
      },
      fixture.load as never,
    );

    expect(fixture.game.render).toHaveBeenCalledWith(container);
    fixture.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(onContextLost).toHaveBeenCalledOnce();

    fixture.game.app.renderer.context.isLost = true;
    expect(handle.isContextLost()).toBe(true);
    handle.destroy();
    expect(fixture.game.destroy).toHaveBeenCalledOnce();

    fixture.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(onContextLost).toHaveBeenCalledOnce();
  });

  it("waves before quitting and cancels a pending quit when destroyed", async () => {
    vi.useFakeTimers();
    const fixture = makeGame();
    const onQuit = vi.fn();
    const handle = await mountHedgehogMode(
      {} as HTMLDivElement,
      { assetsUrl: "/hedgehog-mode", onQuit },
      fixture.load as never,
    );

    fixture.constructorOptions()?.onQuit(fixture.game);
    expect(fixture.sprite.updateSprite).toHaveBeenCalledWith("wave", {
      reset: true,
      loop: false,
    });
    expect(onQuit).not.toHaveBeenCalled();

    handle.destroy();
    vi.advanceTimersByTime(1_000);
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("destroys a game whose render fails", async () => {
    const renderError = new Error("render failed");
    const fixture = makeGame({ renderError });

    await expect(
      mountHedgehogMode(
        {} as HTMLDivElement,
        { assetsUrl: "/hedgehog-mode", onQuit: vi.fn() },
        fixture.load as never,
      ),
    ).rejects.toBe(renderError);
    expect(fixture.game.destroy).toHaveBeenCalledOnce();
  });
});
