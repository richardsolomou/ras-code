import type { DesktopBridge } from "@ras-code/contracts";
import { safeErrorLogAttributes } from "@ras-code/client-runtime/errors";

export interface DockIconColors {
  /** The rounded plate behind the mark: the app's chrome colour. */
  readonly plate: string;
  /** The lit lamps: the app's wordmark colour. */
  readonly lamp: string;
}

export type DockIconContext = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "globalAlpha" | "clearRect" | "beginPath" | "roundRect" | "fill"
>;

export const DOCK_ICON_SIZE = 1024;

// macOS icon plate: an 824px body centred on a 1024px canvas, so the shadow
// and dock scaling have the margin the platform expects.
const PLATE_INSET = 100;
const PLATE_RADIUS = 185;

// The lamp-R mark, in the units of the shipped icon art (a 128 canvas holding
// a 3x5 grid of 18px cells on a 24px pitch, scaled to 0.82 of the plate).
const MARK_CANVAS = 128;
const MARK_FILL = 0.82;
const CELL = 18;
const CELL_RADIUS = 3;
const CELL_PITCH = 24;
const COLUMNS = 3;
const ROWS = 5;
const UNLIT_ALPHA = 0.18;
const LIT_CELLS: ReadonlyArray<readonly [column: number, row: number]> = [
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
];

const MARK_SCALE = ((DOCK_ICON_SIZE - PLATE_INSET * 2) * MARK_FILL) / MARK_CANVAS;
const LIT_CELL_KEYS = new Set(LIT_CELLS.map(([column, row]) => `${column},${row}`));

export function drawDockIcon(context: DockIconContext, colors: DockIconColors): void {
  const plateSize = DOCK_ICON_SIZE - PLATE_INSET * 2;
  context.clearRect(0, 0, DOCK_ICON_SIZE, DOCK_ICON_SIZE);
  context.globalAlpha = 1;
  context.fillStyle = colors.plate;
  context.beginPath();
  context.roundRect(PLATE_INSET, PLATE_INSET, plateSize, plateSize, PLATE_RADIUS);
  context.fill();

  const cell = CELL * MARK_SCALE;
  const pitch = CELL_PITCH * MARK_SCALE;
  const originX = (DOCK_ICON_SIZE - ((COLUMNS - 1) * pitch + cell)) / 2;
  const originY = (DOCK_ICON_SIZE - ((ROWS - 1) * pitch + cell)) / 2;
  context.fillStyle = colors.lamp;
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      context.globalAlpha = LIT_CELL_KEYS.has(`${column},${row}`) ? 1 : UNLIT_ALPHA;
      context.beginPath();
      context.roundRect(
        originX + column * pitch,
        originY + row * pitch,
        cell,
        cell,
        CELL_RADIUS * MARK_SCALE,
      );
      context.fill();
    }
  }
  context.globalAlpha = 1;
}

const TRANSPARENT_COLORS = new Set(["transparent", "rgba(0, 0, 0, 0)", "rgba(0 0 0 / 0)"]);

/**
 * Reads the live values of the theme tokens the icon uses. A probe element is
 * cheaper and more reliable than parsing the custom properties ourselves: the
 * browser resolves whatever the token holds (var chains, oklch, color-mix) to
 * an opaque colour the canvas can paint.
 */
export function resolveDockIconColors(): DockIconColors | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null;
  const host = document.body ?? document.documentElement;
  if (!host) return null;

  const probe = document.createElement("div");
  probe.style.display = "none";
  host.append(probe);
  try {
    const read = (token: string): string | null => {
      probe.style.backgroundColor = `var(${token})`;
      const value = getComputedStyle(probe).backgroundColor.trim();
      return value && !TRANSPARENT_COLORS.has(value) ? value : null;
    };
    const plate = read("--app-chrome-background");
    const lamp = read("--wordmark");
    return plate && lamp ? { plate, lamp } : null;
  } finally {
    probe.remove();
  }
}

/**
 * The renderer draws the tile because Electron's `nativeImage` cannot rasterise
 * SVG: a canvas here is cheaper than an offscreen window in the main process,
 * and it lets the browser resolve the theme colours it already computed.
 */
export function renderDockIconPng(colors: DockIconColors): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = DOCK_ICON_SIZE;
  canvas.height = DOCK_ICON_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  drawDockIcon(context, colors);
  return canvas.toDataURL("image/png");
}

export interface DockIconBridge {
  readonly setDockIcon: (pngDataUrl: string) => Promise<boolean>;
}

function readDockIconBridge(): DockIconBridge | null {
  if (typeof window === "undefined") return null;
  const bridge: DesktopBridge | undefined = window.desktopBridge;
  const setDockIcon = bridge?.setDockIcon;
  if (bridge === undefined || typeof setDockIcon !== "function") return null;
  // Only macOS has a dock tile; every other platform keeps the packaged icon.
  if (bridge.getClientPlatform?.() !== "darwin") return null;
  return { setDockIcon: (pngDataUrl) => setDockIcon.call(bridge, pngDataUrl) };
}

export interface DockIconSyncDependencies {
  readonly readBridge?: () => DockIconBridge | null;
  readonly resolveColors?: () => DockIconColors | null;
  readonly render?: (colors: DockIconColors) => string | null;
}

/**
 * Builds the repaint step: it redraws the dock tile only when the theme colours
 * it depends on actually changed, so ordinary theme churn costs one style read.
 */
export function createDockIconSync({
  readBridge = readDockIconBridge,
  resolveColors = resolveDockIconColors,
  render = renderDockIconPng,
}: DockIconSyncDependencies = {}): () => void {
  let painted: string | null = null;
  return () => {
    const bridge = readBridge();
    if (bridge === null) return;
    const colors = resolveColors();
    if (colors === null) return;
    const signature = `${colors.plate}|${colors.lamp}`;
    if (signature === painted) return;
    const pngDataUrl = render(colors);
    if (pngDataUrl === null) return;
    painted = signature;
    void bridge.setDockIcon(pngDataUrl).catch((cause: unknown) => {
      if (painted === signature) painted = null;
      console.error("Failed to paint the desktop dock icon.", safeErrorLogAttributes(cause));
    });
  };
}

const DOCK_ICON_DEBOUNCE_MS = 150;

const syncDockIcon = createDockIconSync();
let pendingSync: ReturnType<typeof setTimeout> | null = null;

/** Repaints the macOS dock icon from the applied theme; a no-op everywhere else. */
export function syncDesktopDockIcon(): void {
  if (pendingSync !== null) clearTimeout(pendingSync);
  pendingSync = setTimeout(() => {
    pendingSync = null;
    syncDockIcon();
  }, DOCK_ICON_DEBOUNCE_MS);
}
