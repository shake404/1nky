import { identiconSeed } from '@1nky/protocol';

/**
 * A tiny 5x5 symmetric block drawn from the writer's pubkey.
 *
 * Purely a recognition aid that sits next to the tag and the mark: tag names
 * are not unique, so the eye needs something that is. Deterministic forever
 * for a given pubkey.
 */

const GRID = 5;
const HALF = Math.ceil(GRID / 2); // columns 0..2, mirrored into 3..4

/** xorshift32 — small, fast, and stable across engines. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

export interface IdenticonPattern {
  /** GRID*GRID booleans, row-major. */
  cells: boolean[];
  /** Ink colour for the filled blocks. */
  colour: string;
  size: number;
}

/** Deterministic pattern for a pubkey. Same key in, same picture out. */
export function identicon(pubkey: string): IdenticonPattern {
  const next = prng(identiconSeed(pubkey));
  const cells = new Array<boolean>(GRID * GRID).fill(false);

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < HALF; x++) {
      const on = (next() & 0b11) > 0; // ~75% fill; reads as a solid mark
      cells[y * GRID + x] = on;
      cells[y * GRID + (GRID - 1 - x)] = on;
    }
  }

  // Never emit a blank tile.
  if (!cells.some(Boolean)) {
    cells[2 * GRID + 2] = true;
  }

  const hue = next() % 360;
  return { cells, colour: `hsl(${hue} 78% 62%)`, size: GRID };
}

/** Paint a pattern into a canvas. */
export function drawIdenticon(canvas: HTMLCanvasElement, pubkey: string, pixels: number): void {
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(3, devicePixelRatio) : 1;
  canvas.width = Math.round(pixels * dpr);
  canvas.height = Math.round(pixels * dpr);
  canvas.style.width = `${pixels}px`;
  canvas.style.height = `${pixels}px`;

  const context = canvas.getContext('2d');
  if (!context) return;

  const { cells, colour, size } = identicon(pubkey);
  const cell = canvas.width / size;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#0d0d0d';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = colour;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    const x = (i % size) * cell;
    const y = Math.floor(i / size) * cell;
    context.fillRect(Math.floor(x), Math.floor(y), Math.ceil(cell), Math.ceil(cell));
  }
}
