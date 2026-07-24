import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { committedPowTarget, hasValidPow, minePow, powBits, powTag } from './pow.js';

const zeros = (n: number) => '0'.repeat(n);

describe('powBits', () => {
  it.each([
    // [event id, expected leading zero bits]
    [zeros(64), 256],
    [zeros(63) + '1', 255],
    [zeros(63) + 'f', 252],
    [zeros(60) + 'ffff', 240],
    // The worked example from NIP-13 itself (difficulty 36).
    ['000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d', 36],
    ['f' + zeros(63), 0],
    ['8' + zeros(63), 0],
    ['4' + zeros(63), 1],
    ['1' + zeros(63), 3],
    ['0' + '8' + zeros(62), 4],
    ['002f' + zeros(60), 10],
  ])('%s -> %i bits', (id, expected) => {
    expect(powBits(id)).toBe(expected);
  });

  it('rejects malformed ids instead of guessing', () => {
    expect(() => powBits('00ff')).toThrow(TypeError);
    expect(() => powBits(zeros(63) + 'F')).toThrow(TypeError);
    expect(() => powBits(zeros(63) + 'g')).toThrow(TypeError);
  });
});

describe('committedPowTarget', () => {
  it('reads the third element of the nonce tag', () => {
    expect(committedPowTarget({ id: zeros(64), tags: [['nonce', '4242', '20']] })).toBe(20);
  });

  it('is null when there is no nonce tag or no committed target', () => {
    expect(committedPowTarget({ id: zeros(64), tags: [] })).toBeNull();
    expect(committedPowTarget({ id: zeros(64), tags: [['nonce', '4242']] })).toBeNull();
    expect(committedPowTarget({ id: zeros(64), tags: [['nonce', '4242', '']] })).toBeNull();
  });

  it('is NaN when the committed target is unparseable', () => {
    expect(committedPowTarget({ id: zeros(64), tags: [['nonce', '1', 'lots']] })).toBeNaN();
    expect(committedPowTarget({ id: zeros(64), tags: [['nonce', '1', '-4']] })).toBeNaN();
  });
});

describe('hasValidPow', () => {
  // 36 actual leading zero bits.
  const id36 = '000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d';

  it('accepts an event whose id meets the bar and commits to it', () => {
    const event = { id: id36, tags: [powTag(9999, 36)] };
    expect(hasValidPow(event, 36)).toBe(true);
    expect(hasValidPow(event, 20)).toBe(true);
  });

  it('rejects an event whose id is below the bar', () => {
    expect(hasValidPow({ id: id36, tags: [powTag(1, 40)] }, 40)).toBe(false);
  });

  it('rejects a lucky low-work event: committed target below minBits', () => {
    // 36 actual bits is plenty, but the author only ever committed to 8 —
    // they mined for a weak target and got lucky. NIP-13 says reject.
    const lucky = { id: id36, tags: [['nonce', '1', '8']] };
    expect(powBits(lucky.id)).toBeGreaterThanOrEqual(16);
    expect(hasValidPow(lucky, 16)).toBe(false);
    expect(hasValidPow(lucky, 8)).toBe(true);
  });

  it('rejects an id that does not reach its own committed target', () => {
    expect(hasValidPow({ id: id36, tags: [['nonce', '1', '64']] }, 16)).toBe(false);
  });

  it('rejects a malformed committed target', () => {
    expect(hasValidPow({ id: id36, tags: [['nonce', '1', 'twenty']] }, 16)).toBe(false);
  });

  it('honours requireCommitment for the relay write-policy path', () => {
    const uncommitted = { id: id36, tags: [['nonce', '1']] };
    expect(hasValidPow(uncommitted, 16)).toBe(true);
    expect(hasValidPow(uncommitted, 16, { requireCommitment: true })).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(hasValidPow({ id: 'deadbeef', tags: [] }, 0)).toBe(false);
  });

  it('rejects a nonsense minBits', () => {
    expect(() => hasValidPow({ id: id36, tags: [] }, -1)).toThrow(TypeError);
    expect(() => hasValidPow({ id: id36, tags: [] }, 1.5)).toThrow(TypeError);
  });

  it('validates a freshly mined + signed event end to end', () => {
    const sk = generateSecretKey();
    const target = 8;
    const mined = minePow(
      {
        kind: 1,
        tags: [],
        content: 'spraying',
        created_at: Math.floor(Date.now() / 1000),
        pubkey: getPublicKey(sk),
      },
      target,
    );
    const signed = finalizeEvent(
      { kind: mined.kind, tags: mined.tags, content: mined.content, created_at: mined.created_at },
      sk,
    );
    expect(signed.id).toBe(mined.id);
    expect(hasValidPow(signed, target, { requireCommitment: true })).toBe(true);
    expect(committedPowTarget(signed)).toBe(target);
  });
});
