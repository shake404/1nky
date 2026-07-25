import { describe, expect, it } from 'vitest';
import { clampOffset, coverBase } from './AvatarCropper.js';

describe('coverBase', () => {
  it('scales the smaller dimension up so the square is covered', () => {
    // A wide image: height is the tight dimension, so base = stage/height.
    expect(coverBase(400, 200, 260)).toBeCloseTo(260 / 200);
    // A tall image: width is tight.
    expect(coverBase(200, 400, 260)).toBeCloseTo(260 / 200);
    // A square image just fits.
    expect(coverBase(200, 200, 260)).toBeCloseTo(260 / 200);
  });

  it('never divides by zero on a degenerate image', () => {
    expect(coverBase(0, 0, 260)).toBe(1);
  });
});

describe('clampOffset', () => {
  it('keeps the image covering the square — no gap top-left or bottom-right', () => {
    const stage = 260;
    const draw = 400; // image larger than the stage
    // Dragging past the top-left edge is pinned at 0.
    expect(clampOffset(50, draw, stage)).toBe(0);
    // Dragging past the bottom-right edge is pinned at stage - draw.
    expect(clampOffset(-999, draw, stage)).toBe(stage - draw);
    // A valid position in range is left alone.
    expect(clampOffset(-70, draw, stage)).toBe(-70);
  });
});
