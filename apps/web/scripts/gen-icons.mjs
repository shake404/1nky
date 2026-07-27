/**
 * Generates the "1" mark — the numeral "1" set in Bodega, the display face
 * the wordmark already uses, filled flat black and sized to fill the canvas.
 * No ring, no chrome gradient — just the glyph.
 *
 * The glyph outline comes straight out of the real Bodega font file via
 * opentype.js (fonts do not reliably render inside SVG favicons, so the
 * glyph is converted to a plain SVG path at build time here) — this is the
 * ONLY place in the repo that needs a font-parsing library, and it stays a
 * devDependency of this workspace alone.
 *
 * PNGs are still produced with zero image-processing dependencies: the hand
 * -rolled PNG encoder from the previous version of this script is kept, and
 * the glyph's bezier outline is flattened and scan-filled by hand (nonzero
 * winding rule, 4x4 supersampled for antialiasing) straight onto the pixel
 * buffer. Same reasoning as before — we refuse to pull `sharp` or `canvas`
 * into the web workspace just to paint a letter.
 *
 *   node scripts/gen-icons.mjs
 *
 * Regenerating: this script is the single source of the mark. Re-run it
 * whenever Bodega-Plain is replaced and every icon/favicon here is rebuilt
 * from the font again — nothing about the mark's geometry is hand-edited.
 */
import opentype from 'opentype.js';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(SCRIPT_DIR, '..', 'public');
const REPO_ROOT = join(SCRIPT_DIR, '..', '..', '..');
// Font SOURCE lives in gitignored .internal/ (licensed font — not redistributed
// in the public repo; the woff2 the app actually ships is in public/fonts/).
// Icons are pre-generated and committed, so a public checkout never needs this
// unless it is regenerating the icon set.
const FONT_PATH = join(REPO_ROOT, '.internal', 'Bodega-extracted', 'Fonts', 'Bodega-Plain.otf');

const BLACK = [0x00, 0x00, 0x00];
// The two icons platform rules require to be fully opaque (Android maskable,
// iOS apple-touch) get a white fill so the black glyph stays legible — a flat
// black glyph on the app's near-black --soot background would be invisible.
const WHITE = [0xff, 0xff, 0xff];

// --- Load the real font and pull the "1" glyph's outline -------------------
const fontBuf = readFileSync(FONT_PATH);
const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
const glyph = font.charToGlyph('1');

// Reference pass at an arbitrary font size, purely to measure the glyph's
// natural aspect ratio so later passes can scale it to an exact target
// height and know how wide the result will be.
const REF_SIZE = 1000;
const refBBox = glyph.getPath(0, 0, REF_SIZE).getBoundingBox();
const refHeight = refBBox.y2 - refBBox.y1;

/**
 * Builds the glyph path (already scaled and centred) for one canvas size.
 * `glyphHeightFrac` is how much of the canvas height the glyph fills —
 * the maskable icon uses a smaller fraction so the mark sits inside
 * Android's safe zone once the OS crops a full-bleed mask over it.
 */
function buildGeometry(size, glyphHeightFrac) {
  const center = size / 2;
  const targetHeight = size * glyphHeightFrac;
  const fontSize = REF_SIZE * (targetHeight / refHeight);

  // First pass at the origin to measure exactly where this fontSize's glyph
  // sits, then a second pass offsets it so its own bounding-box centre lands
  // on the canvas centre (an opentype glyph's advance width is not its ink
  // centre, so this two-pass centring is needed for it to look centred).
  const probe = glyph.getPath(0, 0, fontSize).getBoundingBox();
  const offsetX = center - (probe.x1 + probe.x2) / 2;
  const offsetY = center - (probe.y1 + probe.y2) / 2;
  const path = glyph.getPath(offsetX, offsetY, fontSize);
  const bbox = path.getBoundingBox();

  return { center, path, bbox };
}

// --- Flatten the glyph's bezier outline into polygons ----------------------
function flattenPath(commands, segments = 24) {
  const subpaths = [];
  let current = null;
  let cursor = [0, 0];
  let start = [0, 0];

  const cubic = (p0, p1, p2, p3) => {
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const mt = 1 - t;
      const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0];
      const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1];
      current.push([x, y]);
    }
  };
  const quad = (p0, p1, p2) => {
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const mt = 1 - t;
      const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
      const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
      current.push([x, y]);
    }
  };

  for (const cmd of commands) {
    if (cmd.type === 'M') {
      current = [];
      subpaths.push(current);
      cursor = [cmd.x, cmd.y];
      start = cursor;
      current.push(cursor);
    } else if (cmd.type === 'L') {
      cursor = [cmd.x, cmd.y];
      current.push(cursor);
    } else if (cmd.type === 'C') {
      cubic(cursor, [cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [cmd.x, cmd.y]);
      cursor = [cmd.x, cmd.y];
    } else if (cmd.type === 'Q') {
      quad(cursor, [cmd.x1, cmd.y1], [cmd.x, cmd.y]);
      cursor = [cmd.x, cmd.y];
    } else if (cmd.type === 'Z') {
      current.push(start);
      cursor = start;
    }
  }
  return subpaths;
}

// Nonzero-winding point-in-polygon test across every subpath at once (a
// glyph with a counter, e.g. an "o", relies on this combining all of its
// contours — the "1" here is a single contour, but this stays generic).
function windingNumber(px, py, subpaths) {
  let wn = 0;
  for (const pts of subpaths) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      if (y1 <= py) {
        if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) wn++;
      } else if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) {
        wn--;
      }
    }
  }
  return wn;
}

// --- PNG encoder (unchanged approach: hand-rolled over node:zlib) ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgba row-major RGBA */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (1 + w * 4) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** RGBA canvas. `bg` of null means fully transparent (browser-tab icons);
 * otherwise an opaque [r,g,b] fill (maskable + apple-touch, which must not
 * be transparent per their platforms' rules). */
function canvas(size, bg) {
  const px = new Uint8Array(size * size * 4);
  if (bg) {
    for (let i = 0; i < size * size; i++) {
      px[i * 4] = bg[0];
      px[i * 4 + 1] = bg[1];
      px[i * 4 + 2] = bg[2];
      px[i * 4 + 3] = 255;
    }
  }
  return px;
}

/** Straight-alpha "source over" so the glyph composites correctly onto the
 * transparent canvas as well as onto an opaque one. */
function blendPixel(px, size, x, y, colour, alpha) {
  if (alpha <= 0) return;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  if (alpha >= 1) {
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
    px[i + 3] = 255;
    return;
  }
  const destA = px[i + 3] / 255;
  const outA = alpha + destA * (1 - alpha);
  if (outA <= 0) return;
  px[i] = Math.round((colour[0] * alpha + px[i] * destA * (1 - alpha)) / outA);
  px[i + 1] = Math.round((colour[1] * alpha + px[i + 1] * destA * (1 - alpha)) / outA);
  px[i + 2] = Math.round((colour[2] * alpha + px[i + 2] * destA * (1 - alpha)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

/** Fills flattened glyph subpaths with a flat colour, 4x4 supersampled for
 * antialiased edges. */
function fillGlyph(px, size, subpaths, bbox, colour) {
  const SS = 4;
  const minX = Math.max(0, Math.floor(bbox.x1 - 1));
  const maxX = Math.min(size - 1, Math.ceil(bbox.x2 + 1));
  const minY = Math.max(0, Math.floor(bbox.y1 - 1));
  const maxY = Math.min(size - 1, Math.ceil(bbox.y2 + 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS;
          const py_ = y + (sy + 0.5) / SS;
          if (windingNumber(px_, py_, subpaths) !== 0) hits++;
        }
      }
      if (hits === 0) continue;
      blendPixel(px, size, x, y, colour, hits / (SS * SS));
    }
  }
}

function buildIcon(size, { glyphHeightFrac, solid = false }) {
  const px = canvas(size, solid ? WHITE : null);
  const { path, bbox } = buildGeometry(size, glyphHeightFrac);
  const subpaths = flattenPath(path.commands);
  fillGlyph(px, size, subpaths, bbox, BLACK);
  return encodePng(size, size, px);
}

/** Builds the standalone SVG mark — the same font-derived path, flat black. */
function buildSvg(size, { glyphHeightFrac, solid = false }) {
  const CANVAS = 512; // fixed design canvas; width/height attrs just scale it
  const { path } = buildGeometry(CANVAS, glyphHeightFrac);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${size}" height="${size}">
${solid ? `  <rect width="${CANVAS}" height="${CANVAS}" fill="#ffffff"/>\n` : ''}  <path d="${path.toPathData(2)}" fill="#000000"/>
</svg>
`;
}

// --- Write everything --------------------------------------------------------
mkdirSync(OUT, { recursive: true });

// Browser-tab icons are transparent — just the glyph, big, no ring, no chrome.
// The two platform icons that MUST stay opaque get a white fill: Android's
// maskable spec crops a full-bleed shape (transparency shows the OS surface
// through the corners), and iOS composites apple-touch transparency onto
// white anyway — a flat black glyph needs a white backing to read at all.
const NORMAL = { glyphHeightFrac: 0.92 };
const MASKABLE = { glyphHeightFrac: 0.55, solid: true }; // inside Android's safe zone
const APPLE = { glyphHeightFrac: 0.8, solid: true };

writeFileSync(join(OUT, 'favicon.svg'), buildSvg(64, NORMAL));
writeFileSync(join(OUT, 'icon.svg'), buildSvg(512, NORMAL));
writeFileSync(join(OUT, 'icon-192.png'), buildIcon(192, NORMAL));
writeFileSync(join(OUT, 'icon-512.png'), buildIcon(512, NORMAL));
writeFileSync(join(OUT, 'icon-maskable-512.png'), buildIcon(512, MASKABLE));
writeFileSync(join(OUT, 'apple-touch-icon.png'), buildIcon(180, APPLE));
// Small PNG fallback for consumers that don't want the SVG (e.g. the docs
// site's <link rel="icon">) — same mark, favicon-sized.
writeFileSync(join(OUT, 'favicon-48.png'), buildIcon(48, NORMAL));

console.log('icons written to public/');
