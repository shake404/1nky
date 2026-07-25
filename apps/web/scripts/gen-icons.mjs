/**
 * Generates the PWA icon PNGs with zero dependencies.
 *
 * We refuse to pull `sharp` (or any image lib) into the web workspace just to
 * paint four squares, so this hand-rolls a minimal PNG encoder on top of
 * node:zlib. Output is a soot tile with an ink hairline and the "1NKY"
 * wordmark drawn from a hand-plotted 5x7 bitmap font — banded top-to-bottom
 * so it reads as chrome, and dropped onto a hard black shadow like any
 * throwie ever painted.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SOOT = [0x0c, 0x0a, 0x11];
const KEYLINE = [0x06, 0x05, 0x0a];
const INK = [0xff, 0x3d, 0x8a];

// One chrome ramp per glyph row (5x7 font): highlight, body, the dark band
// where the horizon cuts across the metal, then the bounce light back up.
const CHROME = [
  [0xff, 0xff, 0xff],
  [0xef, 0xf3, 0xf6],
  [0xdf, 0xe4, 0xe9],
  [0x6f, 0x76, 0x7d],
  [0xc7, 0xce, 0xd4],
  [0xe8, 0xed, 0xf1],
  [0xf4, 0xf7, 0xf9],
];

// --- 5x7 bitmap font, only the glyphs the wordmark needs -------------------
const GLYPHS = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
};

// --- PNG encoder ------------------------------------------------------------
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

/** @param {number} w @param {number} h @param {Uint8Array} rgb row-major RGB */
function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => {
      raw[y * (1 + w * 3) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Canvas -----------------------------------------------------------------
function canvas(size, bg) {
  const px = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }
  return px;
}

function rect(px, size, x0, y0, w, h, colour) {
  for (let y = Math.max(0, y0); y < Math.min(size, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(size, x0 + w); x++) {
      const i = (y * size + x) * 3;
      px[i] = colour[0];
      px[i + 1] = colour[1];
      px[i + 2] = colour[2];
    }
  }
}

/** `ink` is either one RGB triple or a per-glyph-row ramp of them. */
function drawWord(px, size, word, originX, originY, scale, gap, ink) {
  let cx = originX;
  for (const ch of word) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    glyph.forEach((row, ry) => {
      const colour = Array.isArray(ink[0]) ? ink[ry] : ink;
      [...row].forEach((cell, rx) => {
        if (cell === '#') rect(px, size, cx + rx * scale, originY + ry * scale, scale, scale, colour);
      });
    });
    cx += 5 * scale + gap;
  }
}

function build(size, { pad }) {
  const px = canvas(size, SOOT);
  const inset = Math.round(size * pad);
  // ink hairline frame — reads as a sticker edge at small sizes
  const line = Math.max(1, Math.round(size / 64));
  rect(px, size, inset, inset, size - inset * 2, line, INK);
  rect(px, size, inset, size - inset - line, size - inset * 2, line, INK);
  rect(px, size, inset, inset, line, size - inset * 2, INK);
  rect(px, size, size - inset - line, inset, line, size - inset * 2, INK);

  const word = '1NKY';
  const usable = size - inset * 2 - line * 6;
  const scale = Math.max(1, Math.floor(usable / (word.length * 5 + (word.length - 1))));
  const gap = scale;
  const wordW = word.length * 5 * scale + (word.length - 1) * gap;
  const wordH = 7 * scale;
  const x = Math.round((size - wordW) / 2);
  const y = Math.round((size - wordH) / 2);
  // Hard shadow first, down and to the right, then the chrome on top of it.
  const off = Math.max(1, Math.round(scale * 0.7));
  drawWord(px, size, word, x + off, y + off, scale, gap, KEYLINE);
  drawWord(px, size, word, x, y, scale, gap, CHROME);
  return encodePng(size, size, px);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon-192.png'), build(192, { pad: 0.06 }));
writeFileSync(join(OUT, 'icon-512.png'), build(512, { pad: 0.06 }));
// maskable needs 20% safe-area padding so Android's mask never clips the mark
writeFileSync(join(OUT, 'icon-maskable-512.png'), build(512, { pad: 0.2 }));
writeFileSync(join(OUT, 'apple-touch-icon.png'), build(180, { pad: 0.06 }));
console.log('icons written to public/');
