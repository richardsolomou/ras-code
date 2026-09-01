import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getHedgehogModeAssetsUrl, mountHedgehogMode } from "./HedgehogMode";

class FakeCanvas extends EventTarget {}

async function makeDestroyablePackageGame() {
  const fakeWindow = Object.assign(new EventTarget(), {
    cancelAnimationFrame: vi.fn(),
  });
  const addListener = vi.spyOn(fakeWindow, "addEventListener");
  const removeListener = vi.spyOn(fakeWindow, "removeEventListener");
  vi.stubGlobal("window", fakeWindow);

  const { HedgeHogMode } = await import("@posthog/hedgehog-mode");
  const game = new HedgeHogMode({ assetsUrl: "/hedgehog-mode" });
  const appDestroy = vi.fn();
  const internals = game as unknown as {
    addElementTimeout(
      element: object,
      callback: () => void,
      delay: number,
    ): ReturnType<typeof setTimeout>;
    addGlobalListener(target: EventTarget, type: string, listener: EventListener): () => void;
    app: { destroy: typeof appDestroy };
    cleanupListeners: Array<() => void>;
    elements: Array<{ beforeUnload?(): void }>;
    removeElement(element: object): void;
    runner: { frameRequestId: null };
  };
  internals.app = { destroy: appDestroy };
  internals.runner = { frameRequestId: null };

  return { addListener, appDestroy, fakeWindow, game, internals, removeListener };
}

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
    const { addListener, game, removeListener } = await makeDestroyablePackageGame();
    game.destroy();

    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
  });

  it("runs element cleanup and destroys stage children", async () => {
    const { appDestroy, game, internals } = await makeDestroyablePackageGame();
    const beforeUnload = vi.fn();
    internals.elements = [{ beforeUnload }];

    game.destroy();

    expect({
      appDestroy: appDestroy.mock.calls,
      beforeUnload: beforeUnload.mock.calls.length,
    }).toEqual({
      appDestroy: [[{ removeView: true }, { children: true }]],
      beforeUnload: 1,
    });
  });

  it("cancels element timeouts and ignores late removals after teardown", async () => {
    vi.useFakeTimers();
    const { game, internals } = await makeDestroyablePackageGame();
    const beforeUnload = vi.fn();
    const timeoutCallback = vi.fn();
    const element = { beforeUnload };
    internals.elements = [element];
    internals.addElementTimeout(element, timeoutCallback, 1_000);

    game.destroy();
    vi.advanceTimersByTime(1_000);
    internals.removeElement(element);

    expect({
      beforeUnload: beforeUnload.mock.calls.length,
      timeoutCallback: timeoutCallback.mock.calls.length,
    }).toEqual({ beforeUnload: 1, timeoutCallback: 0 });
  });

  it("forgets listeners removed before game teardown", async () => {
    const { fakeWindow, game, internals } = await makeDestroyablePackageGame();
    const listenerCount = internals.cleanupListeners.length;
    const remove = internals.addGlobalListener(fakeWindow, "pointermove", vi.fn());

    remove();

    expect(internals.cleanupListeners).toHaveLength(listenerCount);
    game.destroy();
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
