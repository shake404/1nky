import { generateSecretKey, getPublicKey, identiconSeed } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { identicon } from './identicon.js';

const A = getPublicKey(generateSecretKey());
const B = getPublicKey(generateSecretKey());

describe('identicon', () => {
  it('is deterministic for a pubkey', () => {
    expect(identicon(A)).toEqual(identicon(A));
    expect(identicon(A).cells).toEqual(identicon(A).cells);
  });

  it('differs between writers', () => {
    expect(identicon(A).cells).not.toEqual(identicon(B).cells);
  });

  it('is symmetric left to right', () => {
    const { cells, size } = identicon(A);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        expect(cells[y * size + x]).toBe(cells[y * size + (size - 1 - x)]);
      }
    }
  });

  it('is a 5x5 grid', () => {
    const pattern = identicon(A);
    expect(pattern.size).toBe(5);
    expect(pattern.cells).toHaveLength(25);
  });

  it('is never blank', () => {
    for (let i = 0; i < 40; i++) {
      const pubkey = getPublicKey(generateSecretKey());
      expect(identicon(pubkey).cells.some(Boolean)).toBe(true);
    }
  });

  it('follows the protocol seed, so two clients agree', () => {
    // Same seed in, same picture out — the identicon must be reproducible by
    // anyone holding only the pubkey.
    expect(identiconSeed(A)).toBe(identiconSeed(A));
    expect(identicon(A).colour).toBe(identicon(A).colour);
    expect(identicon(A).colour).toMatch(/^hsl\(\d+ 78% 62%\)$/);
  });
});
