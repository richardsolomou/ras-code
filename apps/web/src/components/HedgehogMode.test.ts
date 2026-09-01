import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getHedgehogModeAssetsUrl, mountHedgehogMode } from "./HedgehogMode";

class FakeCanvas extends EventTarget {}

function makeGame(input?: { readonly renderError?: Error }) {
  const canvas = new FakeCanvas();
  const game = {
    app: {
      canvas,
      renderer: { context: { isLost: false } },
    },
    destroy: vi.fn(),
    render: input?.renderError
      ? vi.fn().mockRejectedValue(input.renderError)
      : vi.fn().mockResolvedValue(undefined),
  };
  function FakeHedgehogMode(this: unknown) {
    return game;
  }
  const load = vi.fn(async () => ({
    HedgeHogMode: FakeHedgehogMode,
  }));
  return { canvas, game, load };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it("removes package global listeners when destroyed", async () => {
    const fakeWindow = Object.assign(new EventTarget(), {
      cancelAnimationFrame: vi.fn(),
    });
    const addListener = vi.spyOn(fakeWindow, "addEventListener");
    const removeListener = vi.spyOn(fakeWindow, "removeEventListener");
    vi.stubGlobal("window", fakeWindow);

    const { HedgeHogMode } = await import("@posthog/hedgehog-mode");
    const game = new HedgeHogMode({ assetsUrl: "/hedgehog-mode" });
    const internals = game as unknown as {
      app: { destroy(): void };
      runner: { frameRequestId: null };
    };
    internals.app = { destroy: vi.fn() };
    internals.runner = { frameRequestId: null };
    game.destroy();

    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
  });

  it("destroys a game whose render fails", async () => {
    const renderError = new Error("render failed");
    const fixture = makeGame({ renderError });

    await expect(
      mountHedgehogMode(
        {} as HTMLDivElement,
        { assetsUrl: "/hedgehog-mode" },
        fixture.load as never,
      ),
    ).rejects.toBe(renderError);
    expect(fixture.game.destroy).toHaveBeenCalledOnce();
  });
});
