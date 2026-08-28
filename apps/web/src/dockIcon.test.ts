import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDockIconSync,
  DOCK_ICON_SIZE,
  drawDockIcon,
  type DockIconColors,
  type DockIconContext,
} from "./dockIcon";

type RecordedRect = {
  readonly fillStyle: string;
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
};

function recordingContext(): { context: DockIconContext; rects: Array<RecordedRect> } {
  const rects: Array<RecordedRect> = [];
  let pending: { x: number; y: number; width: number; height: number; radius: number } | null =
    null;
  const context = {
    fillStyle: "#000000" as CanvasRenderingContext2D["fillStyle"],
    globalAlpha: 1,
    clearRect: () => {},
    beginPath: () => {},
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => {
      pending = { x, y, width, height, radius };
    },
    fill: () => {
      if (pending === null) throw new Error("fill() without a path");
      rects.push({
        fillStyle: String(context.fillStyle),
        alpha: context.globalAlpha,
        ...pending,
      });
      pending = null;
    },
  };
  return { context, rects };
}

const COLORS: DockIconColors = { plate: "rgb(22, 20, 28)", lamp: "rgb(240, 194, 75)" };

function drawnRects() {
  const { context, rects } = recordingContext();
  drawDockIcon(context, COLORS);
  return rects;
}

describe("drawDockIcon", () => {
  it("draws the plate inset on the icon canvas", () => {
    const [plate] = drawnRects();

    expect(plate).toMatchObject({
      fillStyle: COLORS.plate,
      alpha: 1,
      x: 100,
      y: 100,
      width: DOCK_ICON_SIZE - 200,
      height: DOCK_ICON_SIZE - 200,
      radius: 185,
    });
  });

  it("draws every cell of the 3x5 grid in the lamp color", () => {
    const cells = drawnRects().slice(1);

    expect(cells).toHaveLength(15);
    expect(cells.every((cell) => cell.fillStyle === COLORS.lamp)).toBe(true);
  });

  it("lights the cells of the lamp-R and dims the rest", () => {
    const cells = drawnRects().slice(1);
    const columns = 3;
    const lit = cells
      .map((cell, index) => ({ column: index % columns, row: Math.floor(index / columns), cell }))
      .filter(({ cell }) => cell.alpha === 1)
      .map(({ column, row }) => [column, row]);

    expect(lit).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [0, 3],
      [2, 3],
      [0, 4],
      [2, 4],
    ]);
  });

  it("dims the unlit cells instead of hiding them", () => {
    const cells = drawnRects().slice(1);

    expect(cells.filter((cell) => cell.alpha !== 1).map((cell) => cell.alpha)).toEqual([
      0.18, 0.18, 0.18, 0.18, 0.18,
    ]);
  });

  it("centers the mark on the plate", () => {
    const cells = drawnRects().slice(1);
    const left = Math.min(...cells.map((cell) => cell.x));
    const right = Math.max(...cells.map((cell) => cell.x + cell.width));
    const top = Math.min(...cells.map((cell) => cell.y));
    const bottom = Math.max(...cells.map((cell) => cell.y + cell.height));

    expect((left + right) / 2).toBeCloseTo(DOCK_ICON_SIZE / 2, 6);
    expect((top + bottom) / 2).toBeCloseTo(DOCK_ICON_SIZE / 2, 6);
    expect(top).toBeGreaterThan(100);
  });
});

describe("createDockIconSync", () => {
  const bridge = { setDockIcon: vi.fn(() => Promise.resolve(true)) };

  function syncWith(colors: () => DockIconColors | null, render = vi.fn(() => "data:image/png;")) {
    bridge.setDockIcon.mockClear();
    return {
      render,
      sync: createDockIconSync({
        readBridge: () => bridge,
        resolveColors: colors,
        render,
      }),
    };
  }

  it("repaints once while the theme colors stay the same", () => {
    const { sync, render } = syncWith(() => COLORS);

    sync();
    sync();

    expect(render).toHaveBeenCalledTimes(1);
    expect(bridge.setDockIcon).toHaveBeenCalledTimes(1);
  });

  it("repaints when the theme colors change", () => {
    let colors = COLORS;
    const { sync } = syncWith(() => colors);

    sync();
    colors = { plate: "rgb(252, 252, 252)", lamp: "rgb(42, 39, 51)" };
    sync();

    expect(bridge.setDockIcon).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a desktop bridge", () => {
    const render = vi.fn(() => "data:image/png;");
    createDockIconSync({ readBridge: () => null, resolveColors: () => COLORS, render })();

    expect(render).not.toHaveBeenCalled();
  });
});
