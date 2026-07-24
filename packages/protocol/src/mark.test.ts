import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fingerprint, identiconSeed, MARK_LENGTH, sameMark } from './mark.js';

// Frozen golden vectors. If these ever change, every writer's mark changes
// with them and the anti-impersonation signal silently breaks.
const GOLDEN: ReadonlyArray<readonly [string, string, number]> = [
  ['0'.repeat(64), 'hshbqb', 102_683_977],
  ['3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', 'y4rvsj', 1_658_132_002],
  ['82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2', 'as0209', 1_068_887_074],
];

describe('fingerprint (the mark)', () => {
  it.each(GOLDEN)('%s is stable', (pubkey, mark, seed) => {
    expect(fingerprint(pubkey)).toBe(mark);
    expect(identiconSeed(pubkey)).toBe(seed);
  });

  it('is deterministic across repeated calls', () => {
    const pk = getPublicKey(generateSecretKey());
    const once = fingerprint(pk);
    for (let i = 0; i < 5; i++) expect(fingerprint(pk)).toBe(once);
  });

  it('is 6 chars from an unambiguous lowercase alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const mark = fingerprint(getPublicKey(generateSecretKey()));
      expect(mark).toHaveLength(MARK_LENGTH);
      // no i, l, o, u -- they get misread off a phone screen
      expect(mark).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{6}$/);
    }
  });

  it('is not a prefix of the pubkey it came from', () => {
    for (const [pubkey, mark] of GOLDEN) {
      expect(pubkey.startsWith(mark)).toBe(false);
    }
  });

  it('separates writers: no collisions over a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(fingerprint(getPublicKey(generateSecretKey())));
    // 30 bits of entropy: 500 draws should essentially never collide.
    expect(seen.size).toBe(500);
  });

  it('rejects anything that is not a 64-char lowercase hex pubkey', () => {
    expect(() => fingerprint('abc')).toThrow(TypeError);
    expect(() => fingerprint('A'.repeat(64))).toThrow(TypeError);
    expect(() => identiconSeed('')).toThrow(TypeError);
  });
});

describe('identiconSeed', () => {
  it('is an unsigned 32-bit integer', () => {
    for (let i = 0; i < 200; i++) {
      const seed = identiconSeed(getPublicKey(generateSecretKey()));
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  it('uses different digest bits than the mark', () => {
    const [, mark, seed] = GOLDEN[1]!;
    expect(seed.toString(32)).not.toContain(mark);
  });
});

describe('sameMark', () => {
  it('is true only for the same mark', () => {
    const a = getPublicKey(generateSecretKey());
    const b = getPublicKey(generateSecretKey());
    expect(sameMark(a, a)).toBe(true);
    expect(sameMark(a, b)).toBe(false);
  });
});
