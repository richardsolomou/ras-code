// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDockIconSync,
  DOCK_ICON_SIZE,
  drawDockIcon,
  resolveDockIconColors,
  type DockIconColors,
  type DockIconContext,
} from "./dockIcon";

type RecordedRect = {
  readonly fillStyle: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
};

type PendingRect = { x: number; y: number; width: number; height: number; radius: number };

function recordingContext(): {
  context: DockIconContext;
  rects: Array<RecordedRect>;
  clips: Array<PendingRect>;
} {
  const rects: Array<RecordedRect> = [];
  const clips: Array<PendingRect> = [];
  let pending: PendingRect | null = null;
  const context = {
    fillStyle: "#000000" as CanvasRenderingContext2D["fillStyle"],
    clearRect: () => {},
    beginPath: () => {},
    save: () => {},
    restore: () => {},
    rect: (x: number, y: number, width: number, height: number) => {
      pending = { x, y, width, height, radius: 0 };
    },
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => {
      pending = { x, y, width, height, radius };
    },
    clip: () => {
      if (pending === null) throw new Error("clip() without a path");
      clips.push(pending);
      pending = null;
    },
    fill: () => {
      if (pending === null) throw new Error("fill() without a path");
      rects.push({ fillStyle: String(context.fillStyle), ...pending });
      pending = null;
    },
  };
  return { context, rects, clips };
}

const COLORS: DockIconColors = {
  plate: "#0d1117",
  empty: "#21262d",
  low: "#006d32",
  medium: "#26a641",
  high: "#39d353",
};

// The art is authored on a 128-unit canvas scaled onto the 824px plate body.
const ART_SCALE = (DOCK_ICON_SIZE - 200) / 128;
const COLUMNS = 9;

function drawn() {
  const { context, rects, clips } = recordingContext();
  drawDockIcon(context, COLORS);
  return { plate: rects[0], cells: rects.slice(1), clips };
}

describe("drawDockIcon", () => {
  it("draws the plate inset on the icon canvas", () => {
    expect(drawn().plate).toMatchObject({
      fillStyle: COLORS.plate,
      x: 100,
      y: 100,
      width: DOCK_ICON_SIZE - 200,
      height: DOCK_ICON_SIZE - 200,
      radius: 185,
    });
  });

  it("clips the activity field to the plate so no cell escapes its rounded corners", () => {
    const [plateClip] = drawn().clips;

    expect(plateClip).toEqual({
      x: 100,
      y: 100,
      width: DOCK_ICON_SIZE - 200,
      height: DOCK_ICON_SIZE - 200,
      radius: 185,
    });
  });

  it("clips the activity field to the 124-unit box the art paints it across", () => {
    const [, fieldClip] = drawn().clips;

    expect(fieldClip).toEqual({
      x: 100 + 2 * ART_SCALE,
      y: 100 + 2 * ART_SCALE,
      width: 124 * ART_SCALE,
      height: 124 * ART_SCALE,
      radius: 0,
    });
  });

  it("draws the 7x7 field plus the bleed ring the cell pattern lays around it", () => {
    expect(drawn().cells).toHaveLength(COLUMNS * COLUMNS);
  });

  it("runs the bleed ring past the field box so the edge cells render as slivers", () => {
    const { cells } = drawn();
    const fieldLeft = 100 + 2 * ART_SCALE;

    expect(Math.min(...cells.map((cell) => cell.x))).toBeLessThan(fieldLeft);
  });

  it("spells R in the three activity levels", () => {
    const lit = drawn()
      .cells.map((cell, index) => ({
        column: (index % COLUMNS) - 1,
        row: Math.floor(index / COLUMNS) - 1,
        cell,
      }))
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

  it("uses the empty activity color for the rest of the field", () => {
    const { cells } = drawn();

    expect(cells.filter((cell) => cell.fillStyle === COLORS.empty)).toHaveLength(
      COLUMNS * COLUMNS - 10,
    );
  });

  it("centers the field on the icon canvas", () => {
    const { cells } = drawn();
    const left = Math.min(...cells.map((cell) => cell.x));
    const right = Math.max(...cells.map((cell) => cell.x + cell.width));

    expect((left + right) / 2).toBeCloseTo(DOCK_ICON_SIZE / 2, 6);
  });
});

// The dock tile is redrawn in the renderer because Electron cannot rasterise
// SVG, so it is the one copy of the mark that no export step keeps honest.
describe("drawDockIcon against the Icon Composer art", () => {
  const ART = NodeFS.readFileSync(
    new URL("../../../assets/prod/app-icon.icon/Assets/text.svg", import.meta.url),
    "utf8",
  );
  const LEVELS = new Map([
    ["#21262d", COLORS.empty],
    ["#006d32", COLORS.low],
    ["#26a641", COLORS.medium],
    ["#39d353", COLORS.high],
  ]);

  function required<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`The brand layer has no ${what}.`);
    return value;
  }

  function rects(source: string) {
    return [...source.matchAll(/<rect[^>]*>/g)].map((match) => {
      const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? "";
      const number = (name: string) => Number(attribute(name) || 0);
      return {
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
        radius: number("rx"),
        fill: attribute("fill").toLowerCase(),
      };
    });
  }

  /** Expands the art's cell pattern over its field box, in the 128-unit art space. */
  function artCells() {
    const pattern = required(/<pattern[^>]*>[\s\S]*?<\/pattern>/.exec(ART)?.[0], "cell pattern");
    const tile = required(rects(pattern)[0], "pattern tile");
    const origin = Number(required(/<pattern[^>]*\sx="([^"]*)"/.exec(ART)?.[1], "pattern origin"));
    const pitch = Number(
      required(/<pattern[^>]*\swidth="([^"]*)"/.exec(ART)?.[1], "pattern pitch"),
    );
    const [box, ...lit] = rects(ART.slice(ART.indexOf("</defs>")));
    const field = required(box, "field box");
    const litFills = new Map(lit.map((cell) => [`${cell.x},${cell.y}`, cell.fill]));

    // The pattern starts one tile before the field box, so its outermost cells
    // reach the plate edge as slivers.
    const cells = [];
    for (let y = origin - pitch; y < field.y + field.height; y += pitch) {
      for (let x = origin - pitch; x < field.x + field.width; x += pitch) {
        cells.push({
          x,
          y,
          width: tile.width,
          height: tile.height,
          radius: tile.radius,
          fillStyle: required(
            LEVELS.get(litFills.get(`${x},${y}`) ?? tile.fill),
            `activity level for ${litFills.get(`${x},${y}`) ?? tile.fill}`,
          ),
        });
      }
    }
    return { field, cells };
  }

  it("paints the same cells the brand layer does", () => {
    const toArt = (value: number) => Number(((value - 100) / ART_SCALE).toFixed(6));

    expect(
      drawn().cells.map((cell) => ({
        x: toArt(cell.x),
        y: toArt(cell.y),
        width: toArt(cell.x + cell.width) - toArt(cell.x),
        height: toArt(cell.y + cell.height) - toArt(cell.y),
        radius: Number((cell.radius / ART_SCALE).toFixed(6)),
        fillStyle: cell.fillStyle,
      })),
    ).toEqual(artCells().cells);
  });

  it("clips to the same field box the brand layer paints across", () => {
    const fieldClip = required(drawn().clips[1], "field clip");
    const { field } = artCells();

    expect({
      x: (fieldClip.x - 100) / ART_SCALE,
      y: (fieldClip.y - 100) / ART_SCALE,
      width: fieldClip.width / ART_SCALE,
      height: fieldClip.height / ART_SCALE,
    }).toEqual({ x: field.x, y: field.y, width: field.width, height: field.height });
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

describe("resolveDockIconColors", () => {
  it("reads the shared brand tokens", () => {
    const values = new Map([
      ["--brand-background", "#101010"],
      ["--brand-empty", "#202020"],
      ["--brand-low", "#303030"],
      ["--brand-medium", "#404040"],
      ["--brand-high", "#505050"],
    ]);
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (name: string) => values.get(name) ?? "",
    }));

    expect(resolveDockIconColors()).toEqual({
      plate: "#101010",
      empty: "#202020",
      low: "#303030",
      medium: "#404040",
      high: "#505050",
    });
  });
});
