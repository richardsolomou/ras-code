import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";

export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export interface PngIconImage {
  readonly size: number;
  readonly contents: Buffer;
}

/** Encodes PNG renditions directly into a modern, multi-resolution ICO file. */
export function encodePngIco(images: ReadonlyArray<PngIconImage>): Buffer {
  if (images.length === 0) {
    throw new Error("An ICO file requires at least one PNG rendition.");
  }

  const seenSizes = new Set<number>();
  for (const image of images) {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`ICO rendition size must be an integer from 1 to 256, got ${image.size}.`);
    }
    if (seenSizes.has(image.size)) {
      throw new Error(`ICO rendition size ${image.size} was provided more than once.`);
    }
    if (image.contents.length === 0) {
      throw new Error(`ICO rendition ${image.size}x${image.size} is empty.`);
    }
    seenSizes.add(image.size);
  }

  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = directoryEntrySize * images.length;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = header.length;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * directoryEntrySize;
    const encodedSize = image.size === 256 ? 0 : image.size;
    header.writeUInt8(encodedSize, entryOffset);
    header.writeUInt8(encodedSize, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.contents.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.contents.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.contents)]);
}

/** The art's own coordinate space: every layer SVG is authored on a 128 canvas. */
export const ICON_ART_CANVAS = 128;

/**
 * The classic macOS icon body: an 824px rounded square centred on a 1024px
 * canvas. Icon Composer's `macOS pre-Tahoe` rendition is exactly this rectangle
 * — a plain 185px circular corner, with no squircle and no shadow — so the
 * desktop icon is drawn here rather than exported by hand.
 */
export const MACOS_ICON_CANVAS = 1024;
export const MACOS_ICON_BODY_INSET = 100;
export const MACOS_ICON_BODY_RADIUS = 185;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface IconArtwork {
  /** The opaque background the layers sit on, as a CSS colour. */
  readonly background: string;
  /** Layer SVG documents, back to front. */
  readonly layers: ReadonlyArray<string>;
}

interface IconRenderOptions {
  readonly opaque: boolean;
  readonly maskMacosCorners?: boolean;
}

/** `full-bleed` covers iOS, Linux, Windows and the web; the platform masks it. */
export type IconShape = "full-bleed" | "macos";

/**
 * Reads an Icon Composer solid fill. Icon Composer records components in
 * display-p3, but its exporter writes them straight into sRGB, so we do the
 * same and stay byte-comparable with the renditions it used to produce.
 */
export function parseIconFill(fill: string): string {
  const components = fill.startsWith("display-p3:") ? fill.slice("display-p3:".length) : null;
  if (components === null) {
    throw new Error(`Unsupported Icon Composer fill (expected a display-p3 solid): ${fill}`);
  }
  const channels = components
    .split(",")
    .slice(0, 3)
    // An empty component would read as 0 and silently paint the wrong colour.
    .map((component) => (component.trim() === "" ? Number.NaN : Number(component)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`Icon Composer fill is not three numeric components: ${fill}`);
  }
  return `#${channels
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Nests a layer document inside the icon canvas. Layers are whole SVG documents
 * carrying their own `viewBox`, so nesting places them without parsing: the
 * transform maps the 128-unit art onto whatever box the shape asks for.
 */
function placeLayer(layer: string, offset: number, scale: number): string {
  const document = layer.slice(layer.indexOf("<svg"));
  return `<g transform="translate(${offset} ${offset}) scale(${scale})">${document}</g>`;
}

/** Composes one icon rendition as a standalone SVG document. */
export function composeIconSvg(artwork: IconArtwork, shape: IconShape): string {
  if (shape === "full-bleed") {
    const size = ICON_ART_CANVAS;
    return [
      `<svg xmlns="${SVG_NAMESPACE}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
      `<rect width="${size}" height="${size}" fill="${artwork.background}"/>`,
      ...artwork.layers.map((layer) => placeLayer(layer, 0, 1)),
      "</svg>",
    ].join("");
  }

  const canvas = MACOS_ICON_CANVAS;
  const inset = MACOS_ICON_BODY_INSET;
  const body = canvas - inset * 2;
  return [
    `<svg xmlns="${SVG_NAMESPACE}" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">`,
    `<rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${MACOS_ICON_BODY_RADIUS}" fill="${artwork.background}"/>`,
    ...artwork.layers.map((layer) => placeLayer(layer, inset, body / ICON_ART_CANVAS)),
    "</svg>",
  ].join("");
}

/**
 * Rasterises a composed icon SVG into one square PNG rendition. Opaque
 * renditions are re-encoded without an alpha channel: the App Store rejects an
 * iOS app icon that carries one, and full-bleed art covers the canvas anyway.
 */
export function renderIconPng(svg: string, size: number, options: IconRenderOptions): Buffer {
  const rendered = PNG.sync.read(
    new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng(),
  );
  if (options.maskMacosCorners) {
    const inset = (MACOS_ICON_BODY_INSET / MACOS_ICON_CANVAS) * size;
    const body = size - inset * 2;
    const radius = (MACOS_ICON_BODY_RADIUS / MACOS_ICON_CANVAS) * size;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const nearestX = Math.max(inset + radius, Math.min(x + 0.5, inset + body - radius));
        const nearestY = Math.max(inset + radius, Math.min(y + 0.5, inset + body - radius));
        if (Math.hypot(x + 0.5 - nearestX, y + 0.5 - nearestY) <= radius) continue;
        rendered.data[(y * size + x) * 4 + 3] = 0;
      }
    }
  }
  return PNG.sync.write(rendered, { colorType: options.opaque ? 2 : 6 });
}
