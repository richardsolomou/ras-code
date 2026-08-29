import { assert, describe, it } from "@effect/vitest";

import {
  composeIconSvg,
  encodePngIco,
  ICON_ART_CANVAS,
  MACOS_ICON_BODY_INSET,
  MACOS_ICON_BODY_RADIUS,
  MACOS_ICON_CANVAS,
  parseIconFill,
  renderIconPng,
} from "./icon-export.ts";

const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  return contents;
};

const readPngHeader = (contents: Buffer) => ({
  width: contents.readUInt32BE(16),
  height: contents.readUInt32BE(20),
  /** PNG colour type 2 is RGB, 6 is RGBA. */
  colorType: contents.readUInt8(25),
});

const artwork = {
  background: "#16141c",
  layers: [
    '<svg width="128" height="128" viewBox="0 0 128 128"><rect x="31" y="7" width="18" height="18" fill="#F0C24B"/></svg>',
  ],
};

describe("icon export", () => {
  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(18), 38);
    assert.equal(ico.readUInt32LE(34), 38 + small.length);
    assert.deepEqual(ico.subarray(38, 38 + small.length), small);
    assert.deepEqual(ico.subarray(38 + small.length), large);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    assert.throws(
      () =>
        encodePngIco([
          { size: 32, contents: pngHeader(32, 32) },
          { size: 32, contents: pngHeader(32, 32) },
        ]),
      /provided more than once/,
    );
  });

  it("reads an Icon Composer solid fill as an sRGB colour", () => {
    assert.equal(parseIconFill("display-p3:0.08627,0.07843,0.10980,1.00000"), "#16141c");
    assert.equal(parseIconFill("display-p3:1,1,1,1"), "#ffffff");
  });

  it("rejects a fill it cannot read", () => {
    assert.throws(() => parseIconFill("gradient"), /Unsupported Icon Composer fill/);
    assert.throws(() => parseIconFill("display-p3:0.1,0.2"), /three numeric components/);
  });

  it("covers the whole canvas for a full-bleed rendition", () => {
    const svg = composeIconSvg(artwork, "full-bleed");

    assert.include(svg, `viewBox="0 0 ${ICON_ART_CANVAS} ${ICON_ART_CANVAS}"`);
    assert.include(
      svg,
      `<rect width="${ICON_ART_CANVAS}" height="${ICON_ART_CANVAS}" fill="#16141c"/>`,
    );
    assert.include(svg, '<g transform="translate(0 0) scale(1)">');
    assert.include(svg, artwork.layers[0]!);
  });

  it("insets a rounded body for the macOS rendition", () => {
    const body = MACOS_ICON_CANVAS - MACOS_ICON_BODY_INSET * 2;
    const svg = composeIconSvg(artwork, "macos");

    assert.include(svg, `viewBox="0 0 ${MACOS_ICON_CANVAS} ${MACOS_ICON_CANVAS}"`);
    assert.include(
      svg,
      `<rect x="${MACOS_ICON_BODY_INSET}" y="${MACOS_ICON_BODY_INSET}" width="${body}" height="${body}" rx="${MACOS_ICON_BODY_RADIUS}" fill="#16141c"/>`,
    );
    // The art rides the body, not the canvas, so it keeps the classic safe area.
    assert.include(
      svg,
      `<g transform="translate(${MACOS_ICON_BODY_INSET} ${MACOS_ICON_BODY_INSET}) scale(${body / ICON_ART_CANVAS})">`,
    );
  });

  it("renders opaque renditions without an alpha channel and masked ones with it", () => {
    const opaque = readPngHeader(
      renderIconPng(composeIconSvg(artwork, "full-bleed"), 32, { opaque: true }),
    );
    const masked = readPngHeader(
      renderIconPng(composeIconSvg(artwork, "macos"), 64, { opaque: false }),
    );

    assert.deepEqual(opaque, { width: 32, height: 32, colorType: 2 });
    assert.deepEqual(masked, { width: 64, height: 64, colorType: 6 });
  });
});
