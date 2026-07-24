import {
  committedPowTarget,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  hasValidPow,
  powBits,
  KINDS,
  type EventTemplate,
} from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { mineTemplate } from './pow.core.js';

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);

function template(content = 'test'): EventTemplate {
  return { kind: KINDS.FLICK, tags: [['t', 'sf-bay']], content, created_at: Math.floor(Date.now() / 1000) };
}

describe('mineTemplate', () => {
  it('hits the requested difficulty', () => {
    const mined = mineTemplate({ job: '1', template: template(), pubkey, bits: 8 });

    expect(powBits(mined.id)).toBeGreaterThanOrEqual(8);
    expect(hasValidPow(mined, 8, { requireCommitment: true })).toBe(true);
  });

  it('commits the target in the nonce tag', () => {
    const mined = mineTemplate({ job: '1', template: template(), pubkey, bits: 8 });

    expect(committedPowTarget(mined)).toBe(8);
    const nonce = mined.tags.find((tag) => tag[0] === 'nonce');
    expect(nonce?.[2]).toBe('8');
  });

  it('leaves the original template untouched', () => {
    const original = template();
    const before = JSON.stringify(original);
    mineTemplate({ job: '1', template: original, pubkey, bits: 6 });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps the original tags and content', () => {
    const mined = mineTemplate({ job: '1', template: template('caption here'), pubkey, bits: 6 });

    expect(mined.content).toBe('caption here');
    expect(mined.tags).toContainEqual(['t', 'sf-bay']);
    expect(mined.pubkey).toBe(pubkey);
  });

  it('produces an id that survives signing', () => {
    // The mined id must be reproducible from the mined template, or the work
    // is thrown away the moment the event is signed.
    const mined = mineTemplate({ job: '1', template: template(), pubkey, bits: 10 });
    const signed = finalizeEvent(
      { kind: mined.kind, tags: mined.tags, content: mined.content, created_at: mined.created_at },
      secret,
    );

    expect(signed.id).toBe(mined.id);
    expect(hasValidPow(signed, 10, { requireCommitment: true })).toBe(true);
  });

  it('still commits at difficulty zero', () => {
    const mined = mineTemplate({ job: '1', template: template(), pubkey, bits: 0 });
    expect(committedPowTarget(mined)).toBe(0);
  });

  it('rejects nonsense difficulty', () => {
    expect(() => mineTemplate({ job: '1', template: template(), pubkey, bits: -1 })).toThrow();
    expect(() => mineTemplate({ job: '1', template: template(), pubkey, bits: 64 })).toThrow();
  });
});
