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
  "fillStyle" | "globalAlpha" | "clearRect" | "beginPath" | "roundRect" | "fill"
>;

export const DOCK_ICON_SIZE = 1024;

// macOS icon plate: an 824px body centred on a 1024px canvas, so the shadow
// and dock scaling have the margin the platform expects.
const PLATE_INSET = 100;
const PLATE_RADIUS = 185;

const MARK_CANVAS = 128;
const CELL = 12;
const CELL_RADIUS = 2;
const CELL_PITCH = 16;
const GRID_INSET = 10;
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

const MARK_SCALE = (DOCK_ICON_SIZE - PLATE_INSET * 2) / MARK_CANVAS;

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
  const origin = PLATE_INSET + GRID_INSET * MARK_SCALE;
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const level = ACTIVE_CELLS.get(`${column},${row}`);
      context.fillStyle = level === undefined ? colors.empty : colors[level];
      context.beginPath();
      context.roundRect(
        origin + column * pitch,
        origin + row * pitch,
        cell,
        cell,
        CELL_RADIUS * MARK_SCALE,
      );
      context.fill();
    }
  }
  context.globalAlpha = 1;
}

export function resolveDockIconColors(): DockIconColors | null {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return null;
  const styles = getComputedStyle(document.body);
  return {
    plate: styles.getPropertyValue("--brand-background").trim(),
    empty: styles.getPropertyValue("--brand-empty").trim(),
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
