import { describe, expect, it } from 'vitest';

import { HAPPENING_BOARD, normalizeBoard } from './builders.js';
import { LEGAL_PERMISSION_TAG } from './facets.js';
import { canonicalizeBoard, isSystemBoard, MAX_ALIAS_HOPS } from './gazetteer.js';

/**
 * Board canonicalization — the layer that stops one city minting four walls.
 *
 * `normalizeBoard` is the wire format and stays frozen; this sits ABOVE it and
 * folds known spellings of the same place onto one slug. It is pure and takes
 * the alias map as an argument, because the dataset belongs to the web app —
 * the protocol only owns the rule for applying it.
 */

const ALIASES: Record<string, string> = {
  sf: 'san-francisco',
  'sf-bay': 'san-francisco',
  frisco: 'san-francisco',
  nyc: 'new-york-city',
  'new-york': 'new-york-city',
  // An alias whose target is itself an alias — the map is allowed to be lazy.
  ny: 'nyc',
};

describe('canonicalizeBoard', () => {
  it('normalizes exactly like normalizeBoard when no alias matches', () => {
    for (const raw of ['  Oakland ', '#Oakland', 'OAK LAND', 'oakland!']) {
      expect(canonicalizeBoard(raw, ALIASES)).toBe(normalizeBoard(raw));
    }
  });

  it('folds every known spelling of a city onto one slug', () => {
    for (const raw of ['sf', 'SF', ' sf-bay ', 'frisco', '#Frisco', 'san-francisco']) {
      expect(canonicalizeBoard(raw, ALIASES)).toBe('san-francisco');
    }
  });

  it('normalizes before looking the alias up, so messy input still folds', () => {
    expect(canonicalizeBoard('SF Bay', ALIASES)).toBe('san-francisco');
    expect(canonicalizeBoard('New York', ALIASES)).toBe('new-york-city');
  });

  it('follows an alias whose target is another alias', () => {
    expect(canonicalizeBoard('ny', ALIASES)).toBe('new-york-city');
  });

  it('leaves an unknown wall alone rather than guessing', () => {
    expect(canonicalizeBoard('walla-walla', ALIASES)).toBe('walla-walla');
    expect(canonicalizeBoard('holler', ALIASES)).toBe('holler');
  });

  it('works with no alias map at all (plain normalization)', () => {
    expect(canonicalizeBoard('SF Bay')).toBe('sf-bay');
    expect(canonicalizeBoard('sf', {})).toBe('sf');
  });

  it('accepts a Map as readily as a plain object', () => {
    const map = new Map([['sf', 'san-francisco']]);
    expect(canonicalizeBoard('sf', map)).toBe('san-francisco');
  });

  it('returns empty for input that normalizes to nothing', () => {
    expect(canonicalizeBoard('   ', ALIASES)).toBe('');
    expect(canonicalizeBoard('!!!', ALIASES)).toBe('');
  });

  it('never rewrites a system marker, even if the map tries to', () => {
    const hostile = { [HAPPENING_BOARD]: 'san-francisco', [LEGAL_PERMISSION_TAG]: 'oakland' };
    expect(canonicalizeBoard(HAPPENING_BOARD, hostile)).toBe(HAPPENING_BOARD);
    expect(canonicalizeBoard(LEGAL_PERMISSION_TAG, hostile)).toBe(LEGAL_PERMISSION_TAG);
  });

  it('never resolves a facet slug through the map', () => {
    const hostile = { 'type-throwie': 'san-francisco', 'region-bay-area': 'oakland' };
    expect(canonicalizeBoard('type-throwie', hostile)).toBe('type-throwie');
    expect(canonicalizeBoard('region-bay-area', hostile)).toBe('region-bay-area');
  });

  it('stops on a cycle instead of spinning', () => {
    const loop = { a: 'b', b: 'c', c: 'a' };
    // Whatever it lands on, it must terminate and be one of the ring.
    expect(['a', 'b', 'c']).toContain(canonicalizeBoard('a', loop));
  });

  it('stops after a bounded number of hops on a long chain', () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < MAX_ALIAS_HOPS + 5; i += 1) chain[`c${i}`] = `c${i + 1}`;
    // Terminates (does not hang, does not throw) and made progress.
    const out = canonicalizeBoard('c0', chain);
    expect(out.startsWith('c')).toBe(true);
    expect(out).not.toBe('c0');
  });

  it('ignores an alias that points at a system marker or at junk', () => {
    expect(canonicalizeBoard('x', { x: HAPPENING_BOARD })).toBe('x');
    expect(canonicalizeBoard('y', { y: '   ' })).toBe('y');
    expect(canonicalizeBoard('z', { z: 'z' })).toBe('z');
  });

  it('normalizes a sloppy alias target', () => {
    expect(canonicalizeBoard('sfo', { sfo: 'San Francisco' })).toBe('san-francisco');
  });

  it('ignores non-string values from an untrusted map', () => {
    const junk = { sf: 42 } as unknown as Record<string, string>;
    expect(canonicalizeBoard('sf', junk)).toBe('sf');
  });

  it('is not fooled by inherited object properties', () => {
    // A fetched JSON map is a plain object, but `toString`/`constructor` are
    // still reachable via the prototype — they must never look like aliases.
    expect(canonicalizeBoard('toString', ALIASES)).toBe('tostring');
    expect(canonicalizeBoard('constructor', ALIASES)).toBe('constructor');
  });
});

describe('isSystemBoard', () => {
  it('knows the bare system markers', () => {
    expect(isSystemBoard(HAPPENING_BOARD)).toBe(true);
    expect(isSystemBoard(LEGAL_PERMISSION_TAG)).toBe(true);
  });

  it('knows the dash-namespaced facets', () => {
    expect(isSystemBoard('type-throwie')).toBe(true);
    expect(isSystemBoard('surface-street')).toBe(true);
    expect(isSystemBoard('region-bay-area')).toBe(true);
  });

  it('treats an ordinary wall as an ordinary wall', () => {
    expect(isSystemBoard('san-francisco')).toBe(false);
    expect(isSystemBoard('holler')).toBe(false);
    expect(isSystemBoard('')).toBe(false);
  });

  it('normalizes before deciding', () => {
    expect(isSystemBoard(' Happening ')).toBe(true);
  });
});
