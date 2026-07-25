import { describe, expect, it, vi } from 'vitest';
import {
  BLUR_LOAD_FAILED,
  BLUR_MODEL_PATH,
  BLUR_PAD,
  BLUR_WASM_BASE,
  blockSizeFor,
  boxAround,
  coverBoxes,
  detectionsToBoxes,
  findFaces,
  padBox,
  pixelate,
  type Box,
  type Pixels,
} from './blur.js';

/**
 * Covering faces.
 *
 * No real inference here — a detector that downloads twenty megabytes of
 * WebAssembly has no business in a unit test. What IS tested is everything the
 * writer's safety actually rests on: that a box grows before it is covered, that
 * covering destroys the pixels inside it, and that it leaves every pixel outside
 * it exactly as it was.
 */

/** A fake 2D context over a plain array, one byte per channel. */
function surfaceOf(width: number, height: number, fill: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const value = fill(x, y);
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  const puts: { x: number; y: number; width: number; height: number }[] = [];
  return {
    width,
    height,
    data,
    puts,
    at(x: number, y: number): number {
      return data[(y * width + x) * 4] ?? -1;
    },
    getImageData(x: number, y: number, w: number, h: number): Pixels {
      const region = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const from = ((y + row) * width + (x + col)) * 4;
          const to = (row * w + col) * 4;
          region[to] = data[from] ?? 0;
          region[to + 1] = data[from + 1] ?? 0;
          region[to + 2] = data[from + 2] ?? 0;
          region[to + 3] = data[from + 3] ?? 0;
        }
      }
      return { data: region, width: w, height: h };
    },
    putImageData(pixels: Pixels, x: number, y: number): void {
      puts.push({ x, y, width: pixels.width, height: pixels.height });
      for (let row = 0; row < pixels.height; row++) {
        for (let col = 0; col < pixels.width; col++) {
          const from = (row * pixels.width + col) * 4;
          const to = ((y + row) * width + (x + col)) * 4;
          data[to] = pixels.data[from] ?? 0;
          data[to + 1] = pixels.data[from + 1] ?? 0;
          data[to + 2] = pixels.data[from + 2] ?? 0;
          data[to + 3] = pixels.data[from + 3] ?? 0;
        }
      }
    },
  };
}

const FRAME = { width: 200, height: 200 };

describe('padBox', () => {
  it('grows a box about its own centre', () => {
    // 100 wide grows by 30% -> 130, so 15 more on each side.
    expect(padBox({ x: 50, y: 50, width: 100, height: 100 }, { width: 1000, height: 1000 })).toEqual({
      x: 35,
      y: 35,
      width: 130,
      height: 130,
    });
  });

  it('never leaves the picture', () => {
    const padded = padBox({ x: 0, y: 0, width: 40, height: 40 }, FRAME);
    expect(padded.x).toBe(0);
    expect(padded.y).toBe(0);

    const corner = padBox({ x: 180, y: 180, width: 40, height: 40 }, FRAME);
    expect(corner.x + corner.width).toBe(200);
    expect(corner.y + corner.height).toBe(200);
  });

  it('covers the whole frame when the box already fills it', () => {
    expect(padBox({ x: 0, y: 0, width: 200, height: 200 }, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it('hands back whole pixels only', () => {
    const padded = padBox({ x: 10.4, y: 20.7, width: 33.3, height: 41.9 }, FRAME);
    for (const value of Object.values(padded)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('with no padding asked for, only clips', () => {
    expect(padBox({ x: 10, y: 10, width: 20, height: 20 }, FRAME, 0)).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });
  });

  it('pads by three tenths by default', () => {
    expect(BLUR_PAD).toBe(0.3);
  });
});

describe('blockSizeFor', () => {
  it('scales the mosaic so a face is about six blocks across', () => {
    expect(blockSizeFor({ x: 0, y: 0, width: 600, height: 600 })).toBe(100);
    expect(blockSizeFor({ x: 0, y: 0, width: 120, height: 120 })).toBe(20);
  });

  it('uses the shorter side, so a tall box is still coarse', () => {
    expect(blockSizeFor({ x: 0, y: 0, width: 600, height: 60 })).toBe(10);
  });

  it('never goes finer than eight pixels', () => {
    expect(blockSizeFor({ x: 0, y: 0, width: 12, height: 12 })).toBe(8);
    expect(blockSizeFor({ x: 0, y: 0, width: 1, height: 1 })).toBe(8);
  });
});

describe('pixelate', () => {
  it('averages each block down to one colour', () => {
    // 4x4 of 0,100,200,300-ish values in two 2x2 blocks per row.
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      data[i * 4] = i * 10;
      data[i * 4 + 1] = i * 10;
      data[i * 4 + 2] = i * 10;
      data[i * 4 + 3] = 255;
    }
    const pixels: Pixels = { data, width: 4, height: 4 };

    pixelate(pixels, 2);

    // Top-left block held 0, 10, 40, 50 -> 25.
    for (const index of [0, 1, 4, 5]) {
      expect(data[index * 4]).toBe(25);
    }
    // Top-right block held 20, 30, 60, 70 -> 45.
    for (const index of [2, 3, 6, 7]) {
      expect(data[index * 4]).toBe(45);
    }
    // Alpha is left alone in substance: every pixel was opaque, still is.
    expect(data[3]).toBe(255);
  });

  it('averages a short edge block over what is actually there', () => {
    const data = new Uint8ClampedArray(3 * 1 * 4);
    for (let i = 0; i < 3; i++) {
      data[i * 4] = (i + 1) * 30;
      data[i * 4 + 3] = 255;
    }
    const pixels: Pixels = { data, width: 3, height: 1 };

    pixelate(pixels, 2);

    // First block: 30 and 60 -> 45. Last is a single pixel and keeps itself.
    expect(data[0]).toBe(45);
    expect(data[4]).toBe(45);
    expect(data[8]).toBe(90);
  });

  it('a block of one pixel changes nothing', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 255, 9, 8, 7, 255]);
    pixelate({ data, width: 2, height: 1 }, 1);
    expect([...data]).toEqual([1, 2, 3, 255, 9, 8, 7, 255]);
  });
});

describe('coverBoxes', () => {
  /** A gradient, so any surviving detail is visible as a range of values. */
  const gradient = (x: number, y: number): number => (x * 7 + y * 11) % 256;

  it('destroys the detail inside a box', () => {
    const surface = surfaceOf(200, 200, gradient);
    const box: Box = { x: 60, y: 60, width: 40, height: 40 };

    const applied = coverBoxes(surface, [box], FRAME);

    expect(applied).toHaveLength(1);
    const covered = applied[0]!;
    // The box it actually covered is the padded one.
    expect(covered).toEqual(padBox(box, FRAME));

    // Inside, whole blocks are flat: the four corners of one block agree.
    const block = blockSizeFor(covered);
    const first = surface.at(covered.x, covered.y);
    expect(surface.at(covered.x + block - 1, covered.y)).toBe(first);
    expect(surface.at(covered.x, covered.y + block - 1)).toBe(first);
    expect(surface.at(covered.x + block - 1, covered.y + block - 1)).toBe(first);

    // And it is not simply the untouched gradient any more.
    const before = surfaceOf(200, 200, gradient);
    let changed = 0;
    for (let y = covered.y; y < covered.y + covered.height; y++) {
      for (let x = covered.x; x < covered.x + covered.width; x++) {
        if (surface.at(x, y) !== before.at(x, y)) changed++;
      }
    }
    expect(changed).toBeGreaterThan(covered.width * covered.height * 0.5);
  });

  it('leaves every pixel outside the box exactly as it was', () => {
    const surface = surfaceOf(200, 200, gradient);
    const before = surfaceOf(200, 200, gradient);
    const covered = coverBoxes(surface, [{ x: 60, y: 60, width: 40, height: 40 }], FRAME)[0]!;

    const inside = (x: number, y: number): boolean =>
      x >= covered.x &&
      x < covered.x + covered.width &&
      y >= covered.y &&
      y < covered.y + covered.height;

    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        if (inside(x, y)) continue;
        expect(surface.at(x, y)).toBe(before.at(x, y));
      }
    }
  });

  it('covers every box it is given', () => {
    const surface = surfaceOf(200, 200, gradient);
    const applied = coverBoxes(
      surface,
      [
        { x: 10, y: 10, width: 30, height: 30 },
        { x: 120, y: 130, width: 40, height: 20 },
      ],
      FRAME,
    );
    expect(applied).toHaveLength(2);
    expect(surface.puts).toHaveLength(2);
  });

  it('steps over a box with no area in it', () => {
    const surface = surfaceOf(200, 200, gradient);
    expect(coverBoxes(surface, [{ x: 10, y: 10, width: 0, height: 0 }], FRAME)).toEqual([]);
    expect(surface.puts).toHaveLength(0);
  });

  it('does nothing at all when there is nothing to cover', () => {
    const surface = surfaceOf(20, 20, gradient);
    const before = surfaceOf(20, 20, gradient);
    expect(coverBoxes(surface, [], { width: 20, height: 20 })).toEqual([]);
    expect([...surface.data]).toEqual([...before.data]);
  });
});

describe('detectionsToBoxes', () => {
  it('reads the rectangles the detector found', () => {
    const boxes = detectionsToBoxes({
      detections: [
        { boundingBox: { originX: 10, originY: 20, width: 30, height: 40 } },
        { boundingBox: { originX: 100, originY: 110, width: 50, height: 55 } },
      ],
    });

    expect(boxes).toEqual([
      { x: 10, y: 20, width: 30, height: 40 },
      { x: 100, y: 110, width: 50, height: 55 },
    ]);
  });

  it('steps over anything it cannot read', () => {
    expect(
      detectionsToBoxes({
        detections: [
          {},
          { boundingBox: { originX: 1, originY: 1, width: 0, height: 10 } },
          { boundingBox: { originX: 'x', originY: 1, width: 10, height: 10 } },
          null,
          { boundingBox: { originX: 5, originY: 5, width: 10, height: 10 } },
        ],
      }),
    ).toEqual([{ x: 5, y: 5, width: 10, height: 10 }]);
  });

  it('reads nothing out of nothing', () => {
    expect(detectionsToBoxes(null)).toEqual([]);
    expect(detectionsToBoxes({})).toEqual([]);
    expect(detectionsToBoxes({ detections: 'no' })).toEqual([]);
    expect(detectionsToBoxes({ detections: [] })).toEqual([]);
  });
});

describe('findFaces, with the detector stood in for', () => {
  it('hands the canvas to the detector and covers what comes back', async () => {
    const canvas = { tag: 'canvas' } as unknown as HTMLCanvasElement;
    const detect = vi.fn(() => ({
      detections: [{ boundingBox: { originX: 60, originY: 60, width: 40, height: 40 } }],
    }));

    const boxes = await findFaces({ detect }, canvas);

    expect(detect).toHaveBeenCalledWith(canvas);
    expect(boxes).toEqual([{ x: 60, y: 60, width: 40, height: 40 }]);

    // And those boxes, put through the covering, mutate the picture inside them.
    const surface = surfaceOf(200, 200, (x, y) => (x * 3 + y * 5) % 256);
    const before = surfaceOf(200, 200, (x, y) => (x * 3 + y * 5) % 256);
    const applied = coverBoxes(surface, boxes, FRAME);
    expect(applied).toHaveLength(1);
    expect(surface.at(70, 70)).not.toBe(before.at(70, 70));
    // Well clear of the padded box, nothing moved.
    expect(surface.at(5, 5)).toBe(before.at(5, 5));
  });

  it('waits for a detector that answers later', async () => {
    const boxes = await findFaces(
      {
        detect: async () => ({
          detections: [{ boundingBox: { originX: 1, originY: 2, width: 3, height: 4 } }],
        }),
      },
      {} as unknown as HTMLCanvasElement,
    );
    expect(boxes).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });
});

describe('boxAround', () => {
  it('puts a head-sized square where the writer tapped', () => {
    const box = boxAround({ x: 100, y: 100 }, { width: 400, height: 400 });
    expect(box.width).toBe(72);
    expect(box.height).toBe(72);
    expect(box.x).toBe(64);
    expect(box.y).toBe(64);
  });

  it('stays inside the picture near an edge', () => {
    const box = boxAround({ x: 2, y: 2 }, { width: 400, height: 400 });
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBeGreaterThan(0);
  });

  it('never gets so small it covers nothing', () => {
    const box = boxAround({ x: 20, y: 20 }, { width: 60, height: 60 });
    expect(box.width).toBeGreaterThanOrEqual(24);
  });
});

describe('where the tool comes from', () => {
  it('loads the runtime and the model from this origin, never a CDN', () => {
    expect(BLUR_WASM_BASE).toBe('/models/wasm');
    expect(BLUR_MODEL_PATH).toBe('/models/blaze_face_short_range.tflite');
    for (const path of [BLUR_WASM_BASE, BLUR_MODEL_PATH]) {
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toMatch(/^https?:/);
    }
  });

  it('says so plainly when it cannot be brought up', () => {
    expect(BLUR_LOAD_FAILED).toBe("Couldn't load the blur tool on this device.");
  });
});
