import type { DesktopBridge } from "@ras-code/contracts";
import { safeErrorLogAttributes } from "@ras-code/client-runtime/errors";

export interface DockIconColors {
  readonly plate: string;
  readonly empty: string;
  readonly low: string;
  readonly medium: string;
  readonly high: string;
}

export type DockIconContext = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "clearRect"
  | "beginPath"
  | "roundRect"
  | "rect"
  | "fill"
  | "clip"
  | "save"
  | "restore"
>;

export const DOCK_ICON_SIZE = 1024;

// macOS icon plate: an 824px body centred on a 1024px canvas, so the shadow
// and dock scaling have the margin the platform expects.
const PLATE_INSET = 100;
const PLATE_RADIUS = 185;

// The activity field as `assets/*/app-icon.icon/Assets/text.svg` authors it, on
// the 128-unit canvas every brand layer shares: a 16-unit cell pattern from
// (10, 10) painted across a box inset 2 units. The pattern lays a ring of cells
// around the 7x7 field that the box and the plate corners cut into slivers, so
// the field reaches the plate edge instead of floating inside a margin.
const ART_CANVAS = 128;
const FIELD_INSET = 2;
const CELL = 12;
const CELL_RADIUS = 2;
const CELL_PITCH = 16;
const GRID_ORIGIN = 10;
const COLUMNS = 7;
const ROWS = 7;

const ACTIVE_CELLS = new Map<string, keyof Pick<DockIconColors, "low" | "medium" | "high">>([
  ["2,1", "high"],
  ["3,1", "medium"],
  ["2,2", "medium"],
  ["4,2", "high"],
  ["2,3", "high"],
  ["3,3", "medium"],
  ["2,4", "low"],
  ["4,4", "high"],
  ["2,5", "medium"],
  ["4,5", "low"],
]);

const ART_SCALE = (DOCK_ICON_SIZE - PLATE_INSET * 2) / ART_CANVAS;

function toCanvas(art: number): number {
  return PLATE_INSET + art * ART_SCALE;
}

export function drawDockIcon(context: DockIconContext, colors: DockIconColors): void {
  const plateSize = DOCK_ICON_SIZE - PLATE_INSET * 2;
  context.clearRect(0, 0, DOCK_ICON_SIZE, DOCK_ICON_SIZE);
  context.fillStyle = colors.plate;
  context.beginPath();
  context.roundRect(PLATE_INSET, PLATE_INSET, plateSize, plateSize, PLATE_RADIUS);
  context.fill();

  context.save();
  context.beginPath();
  context.roundRect(PLATE_INSET, PLATE_INSET, plateSize, plateSize, PLATE_RADIUS);
  context.clip();
  context.beginPath();
  context.rect(
    toCanvas(FIELD_INSET),
    toCanvas(FIELD_INSET),
    (ART_CANVAS - FIELD_INSET * 2) * ART_SCALE,
    (ART_CANVAS - FIELD_INSET * 2) * ART_SCALE,
  );
  context.clip();

  const cell = CELL * ART_SCALE;
  for (let row = -1; row <= ROWS; row += 1) {
    for (let column = -1; column <= COLUMNS; column += 1) {
      const level = ACTIVE_CELLS.get(`${column},${row}`);
      context.fillStyle = level === undefined ? colors.empty : colors[level];
      context.beginPath();
      context.roundRect(
        toCanvas(GRID_ORIGIN + column * CELL_PITCH),
        toCanvas(GRID_ORIGIN + row * CELL_PITCH),
        cell,
        cell,
        CELL_RADIUS * ART_SCALE,
      );
      context.fill();
    }
  }
  context.restore();
}

export function resolveDockIconColors(): DockIconColors | null {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return null;
  const styles = getComputedStyle(document.body);
  return {
    plate: styles.getPropertyValue("--dock-icon-background").trim(),
    empty: styles.getPropertyValue("--dock-icon-empty").trim(),
    low: styles.getPropertyValue("--brand-low").trim(),
    medium: styles.getPropertyValue("--brand-medium").trim(),
    high: styles.getPropertyValue("--brand-high").trim(),
  };
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
    const signature = Object.values(colors).join("|");
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
