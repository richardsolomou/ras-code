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

const COLORS: DockIconColors = {
  plate: "#0d1117",
  empty: "#21262d",
  low: "#006d32",
  medium: "#26a641",
  high: "#39d353",
};

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

  it("draws every cell of the 7x7 activity field", () => {
    const cells = drawnRects().slice(1);

    expect(cells).toHaveLength(49);
  });

  it("spells R in the three activity levels", () => {
    const cells = drawnRects().slice(1);
    const columns = 7;
    const lit = cells
      .map((cell, index) => ({ column: index % columns, row: Math.floor(index / columns), cell }))
      .filter(({ cell }) => cell.fillStyle !== COLORS.empty)
      .map(({ column, row }) => [column, row]);

    expect(lit).toEqual([
      [2, 1],
      [3, 1],
      [2, 2],
      [4, 2],
      [2, 3],
      [3, 3],
      [2, 4],
      [4, 4],
      [2, 5],
      [4, 5],
    ]);
  });

  it("uses the empty activity color for the background field", () => {
    const cells = drawnRects().slice(1);

    expect(cells.filter((cell) => cell.fillStyle === COLORS.empty)).toHaveLength(39);
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

  it("leaves the plate a narrow margin around the activity field", () => {
    const cells = drawnRects().slice(1);
    const plateSize = DOCK_ICON_SIZE - 200;
    const top = Math.min(...cells.map((cell) => cell.y));

    expect((top - 100) / plateSize).toBeCloseTo(5 / 64, 6);
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
    colors = { ...COLORS, plate: "#ffffff", empty: "#ebedf0" };
    sync();

    expect(bridge.setDockIcon).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a desktop bridge", () => {
    const render = vi.fn(() => "data:image/png;");
    createDockIconSync({ readBridge: () => null, resolveColors: () => COLORS, render })();

    expect(render).not.toHaveBeenCalled();
  });
});
