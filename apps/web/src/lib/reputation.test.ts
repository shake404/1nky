import { describe, expect, it } from 'vitest';
import { onTheWallSince, upLine, wallAge } from './reputation.js';

/**
 * Standing is two facts and nothing else. These tests exist because the
 * temptation to turn "how long, how much" into a score is permanent, and
 * because the honest answer to "we don't know" is silence — never a zero, never
 * a "new here" badge somebody didn't earn a way out of.
 */

const DAY = 86_400;
const NOW = 1_800_000_000;

describe('wallAge', () => {
  it('says nothing at all when the wall does not know', () => {
    expect(wallAge(null, NOW)).toBeNull();
    expect(wallAge(undefined, NOW)).toBeNull();
    expect(wallAge(0, NOW)).toBeNull();
    expect(wallAge(Number.NaN, NOW)).toBeNull();
  });

  it('fills no dots for the first week', () => {
    expect(wallAge(NOW, NOW)?.dots).toBe(0);
    expect(wallAge(NOW - 6 * DAY, NOW)?.dots).toBe(0);
  });

  it('fills one at a week, two at a month, three at six months', () => {
    expect(wallAge(NOW - 7 * DAY, NOW)?.dots).toBe(1);
    expect(wallAge(NOW - 29 * DAY, NOW)?.dots).toBe(1);
    expect(wallAge(NOW - 30 * DAY, NOW)?.dots).toBe(2);
    expect(wallAge(NOW - 179 * DAY, NOW)?.dots).toBe(2);
    expect(wallAge(NOW - 180 * DAY, NOW)?.dots).toBe(3);
    expect(wallAge(NOW - 4000 * DAY, NOW)?.dots).toBe(3);
  });

  it('never goes past three, however long they have been at it', () => {
    const dots = wallAge(NOW - 9000 * DAY, NOW)?.dots ?? -1;
    expect(dots).toBe(3);
  });

  it('spells the age out for a reader who cannot see the dots', () => {
    expect(wallAge(NOW - 3600, NOW)?.label).toBe('up since today');
    expect(wallAge(NOW - DAY, NOW)?.label).toBe('up for 1 day');
    expect(wallAge(NOW - 12 * DAY, NOW)?.label).toBe('up for 12 days');
    expect(wallAge(NOW - 95 * DAY, NOW)?.label).toBe('up for 3 months');
    expect(wallAge(NOW - 400 * DAY, NOW)?.label).toBe('up for 1 year');
    expect(wallAge(NOW - 800 * DAY, NOW)?.label).toBe('up for 2 years');
  });

  it('treats a first-seen in the future as day one rather than a negative age', () => {
    expect(wallAge(NOW + 5 * DAY, NOW)?.days).toBe(0);
  });

  it('says nothing about scores, ranks or points', () => {
    const words = (wallAge(NOW - 200 * DAY, NOW)?.label ?? '').toLowerCase();
    for (const banned of ['score', 'karma', 'rank', 'level', 'points', 'rep']) {
      expect(words).not.toContain(banned);
    }
  });
});

describe('onTheWallSince', () => {
  it('names the month and the year, and no more than that', () => {
    const march = Math.floor(new Date(2025, 2, 17, 13, 45).getTime() / 1000);
    expect(onTheWallSince(march)).toBe('on the wall since March 2025');
  });

  it('has nothing to say without a date', () => {
    expect(onTheWallSince(null)).toBeNull();
    expect(onTheWallSince(undefined)).toBeNull();
  });
});

describe('upLine', () => {
  it('counts what somebody has up', () => {
    expect(upLine(1)).toBe('1 up');
    expect(upLine(12)).toBe('12 up');
  });

  it('stays quiet rather than posting a zero against somebody', () => {
    expect(upLine(0)).toBeNull();
    expect(upLine(null)).toBeNull();
    expect(upLine(undefined)).toBeNull();
    expect(upLine(-4)).toBeNull();
  });
});
