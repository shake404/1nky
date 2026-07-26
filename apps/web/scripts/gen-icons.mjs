/**
 * Generates the "circle-1" mark — the numeral "1" set in Bodega, the display
 * face the wordmark already uses, ringed by a thin ink hairline. It reads as
 * the "1" in 1NKY and as a stylised "i" for inky at once, and it replaces
 * whatever placeholder chrome-wordmark icon used to live in public/.
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
 * into the web workspace just to paint a ring and a letter.
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

// --- Palette — matches apps/web/src/styles/global.css tokens exactly ------
const SOOT = [0x0c, 0x0a, 0x11]; // --soot
const KEYLINE = [0x06, 0x05, 0x0a]; // --keyline
const INK = '#ff3d8a'; // --ink — the thin ring, same colour as the old frame
const INK_RGB = [0xff, 0x3d, 0x8a];

// Chrome ramp — the exact stops of --chrome-display (177deg), sampled
// top-to-bottom over the glyph's own bounding box so the "1" reads as the
// same painted-metal material as the wordmark and every throwie button.
const CHROME_STOPS = [
  { t: 0, c: [0xff, 0xff, 0xff] },
  { t: 0.22, c: [0xcf, 0xd4, 0xd9] },
  { t: 0.46, c: [0x6f, 0x76, 0x7d] },
  { t: 0.51, c: [0x23, 0x27, 0x2b] },
  { t: 0.58, c: [0xb9, 0xc0, 0xc6] },
  { t: 0.74, c: [0xf2, 0xf5, 0xf7] },
  { t: 1, c: [0x7e, 0x85, 0x8c] },
];

function chromeAt(t) {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < CHROME_STOPS.length - 1; i++) {
    const a = CHROME_STOPS[i];
    const b = CHROME_STOPS[i + 1];
    if (clamped >= a.t && clamped <= b.t) {
      const f = (clamped - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
      ];
    }
  }
  return CHROME_STOPS[CHROME_STOPS.length - 1].c;
}

function chromeCssGradient() {
  return CHROME_STOPS.map(
    (s) => `#${s.c.map((v) => v.toString(16).padStart(2, '0')).join('')} ${Math.round(s.t * 100)}%`
  ).join(', ');
}

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
 * Builds the glyph path (already scaled and centred) plus ring geometry for
 * one canvas size. `diameterFrac` is how much of the canvas the ring's outer
 * edge spans — the maskable icon uses a smaller fraction so the mark sits
 * inside Android's safe zone once the OS crops a full-bleed mask over it.
 */
function buildGeometry(size, diameterFrac, glyphHeightFrac = 0.66) {
  const center = size / 2;
  const outerRadius = (size * diameterFrac) / 2;
  // A bold band, not a hairline: at 16px tab size a size/64 ring rendered a
  // quarter-pixel and vanished. size/16 keeps it visible down to favicon scale.
  const strokeWidth = Math.max(2, Math.round(size / 16));

  const targetHeight = outerRadius * 2 * glyphHeightFrac;
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

  return { center, outerRadius, strokeWidth, path, bbox };
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

function setPixel(px, size, x, y, colour) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = colour[0];
  px[i + 1] = colour[1];
  px[i + 2] = colour[2];
  px[i + 3] = 255;
}

/** Straight-alpha "source over" so marks composite correctly onto the
 * transparent canvas as well as onto an opaque one. */
function blendPixel(px, size, x, y, colour, alpha) {
  if (alpha <= 0) return;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  if (alpha >= 1) {
    setPixel(px, size, x, y, colour);
    return;
  }
  const i = (y * size + x) * 4;
  const destA = px[i + 3] / 255;
  const outA = alpha + destA * (1 - alpha);
  if (outA <= 0) return;
  px[i] = Math.round((colour[0] * alpha + px[i] * destA * (1 - alpha)) / outA);
  px[i + 1] = Math.round((colour[1] * alpha + px[i + 1] * destA * (1 - alpha)) / outA);
  px[i + 2] = Math.round((colour[2] * alpha + px[i + 2] * destA * (1 - alpha)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

/** Thin ink ring, antialiased analytically (no supersampling needed for a circle). */
function drawRing(px, size, cx, cy, outerRadius, strokeWidth) {
  const inner = outerRadius - strokeWidth;
  const outer = outerRadius;
  const minX = Math.max(0, Math.floor(cx - outer - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + outer + 1));
  const minY = Math.max(0, Math.floor(cy - outer - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + outer + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const covOuter = Math.max(0, Math.min(1, outer - dist + 0.5));
      const covInner = Math.max(0, Math.min(1, dist - inner + 0.5));
      const coverage = covOuter * covInner;
      blendPixel(px, size, x, y, INK_RGB, coverage);
    }
  }
}

/** Fills flattened glyph subpaths with a colour (solid, or a vertical chrome
 * ramp when `colourFn` is given), 4x4 supersampled for antialiased edges. */
function fillGlyph(px, size, subpaths, bbox, options) {
  const { offsetX = 0, offsetY = 0, colour, colourFn } = options;
  const SS = 4;
  const minX = Math.max(0, Math.floor(bbox.x1 + offsetX - 1));
  const maxX = Math.min(size - 1, Math.ceil(bbox.x2 + offsetX + 1));
  const minY = Math.max(0, Math.floor(bbox.y1 + offsetY - 1));
  const maxY = Math.min(size - 1, Math.ceil(bbox.y2 + offsetY + 1));
  const height = bbox.y2 - bbox.y1 || 1;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS - offsetX;
          const py_ = y + (sy + 0.5) / SS - offsetY;
          if (windingNumber(px_, py_, subpaths) !== 0) hits++;
        }
      }
      if (hits === 0) continue;
      const coverage = hits / (SS * SS);
      const t = (y - bbox.y1) / height;
      const fill = colourFn ? colourFn(t) : colour;
      blendPixel(px, size, x, y, fill, coverage);
    }
  }
}

function buildIcon(size, { diameterFrac, glyphHeightFrac = 0.66, solid = false }) {
  const px = canvas(size, solid ? SOOT : null);
  const { center, outerRadius, strokeWidth, path, bbox } = buildGeometry(size, diameterFrac, glyphHeightFrac);
  const subpaths = flattenPath(path.commands);

  drawRing(px, size, center, center, outerRadius, strokeWidth);

  // The hard offset shadow every throwie in this app casts, down and right.
  const shadowOffset = Math.max(1, Math.round(size / 170));
  fillGlyph(px, size, subpaths, bbox, {
    offsetX: shadowOffset,
    offsetY: shadowOffset,
    colour: KEYLINE,
  });
  fillGlyph(px, size, subpaths, bbox, { colourFn: chromeAt });

  return encodePng(size, size, px);
}

/** Builds the standalone SVG mark — the same font-derived path, exact colours,
 * and the paint-order stroke trick the old wordmark SVGs already used for
 * their hard keyline instead of a separate offset copy. */
function buildSvg(size, { diameterFrac, glyphHeightFrac = 0.66, solid = false }) {
  const CANVAS = 512; // fixed design canvas; width/height attrs just scale it
  const { center, outerRadius, strokeWidth, path } = buildGeometry(CANVAS, diameterFrac, glyphHeightFrac);
  const ringRadius = outerRadius - strokeWidth / 2;
  const glyphStroke = Math.max(2, Math.round(CANVAS / 85));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
${CHROME_STOPS.map((s) => `      <stop offset="${Math.round(s.t * 100)}%" stop-color="#${s.c.map((v) => v.toString(16).padStart(2, '0')).join('')}"/>`).join('\n')}
    </linearGradient>
  </defs>
${solid ? `  <rect width="${CANVAS}" height="${CANVAS}" fill="#0c0a11"/>\n` : ''}  <circle cx="${center}" cy="${center}" r="${ringRadius.toFixed(2)}" fill="none" stroke="${INK}" stroke-width="${strokeWidth}"/>
  <path d="${path.toPathData(2)}" fill="url(#chrome)" stroke="#06050a" stroke-width="${glyphStroke}" paint-order="stroke" stroke-linejoin="round"/>
</svg>
`;
}

// --- Write everything --------------------------------------------------------
mkdirSync(OUT, { recursive: true });

// Browser-tab icons are transparent — just the ring and the 1, no dark slab.
// The two platform icons that MUST stay opaque keep the soot fill: Android's
// maskable spec crops a full-bleed shape (transparency shows the OS surface
// through the corners), and iOS composites apple-touch transparency onto
// white, which would silver-on-white the glyph.
const NORMAL = { diameterFrac: 0.86 };
const MASKABLE = { diameterFrac: 0.6, solid: true }; // ~60% of canvas, inside Android's safe zone
const APPLE = { diameterFrac: 0.86, solid: true };

writeFileSync(join(OUT, 'favicon.svg'), buildSvg(64, NORMAL));
writeFileSync(join(OUT, 'icon.svg'), buildSvg(512, NORMAL));
writeFileSync(join(OUT, 'icon-192.png'), buildIcon(192, NORMAL));
writeFileSync(join(OUT, 'icon-512.png'), buildIcon(512, NORMAL));
writeFileSync(join(OUT, 'icon-maskable-512.png'), buildIcon(512, MASKABLE));
writeFileSync(join(OUT, 'apple-touch-icon.png'), buildIcon(180, APPLE));
// Small PNG fallback for consumers that don't want the SVG (e.g. the docs
// site's <link rel="icon">) — same mark, favicon-sized.
writeFileSync(join(OUT, 'favicon-48.png'), buildIcon(48, NORMAL));

console.log('icons written to public/ — chrome ramp for reference:', chromeCssGradient());
