import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  DM_TEXT_MAX,
  GIFT_WRAP_MAX_BACKDATE_SECONDS,
  giftWrapRecipient,
  unwrapMessage,
  wrapMessage,
} from './dm.js';
import { KINDS } from './kinds.js';
import { committedPowTarget, hasValidPow, powBits } from './pow.js';
import type { SignedEvent } from './types.js';

const alice = generateSecretKey();
const alicePub = getPublicKey(alice);
const bob = generateSecretKey();
const bobPub = getPublicKey(bob);
const mallory = generateSecretKey();

/** Wraps come off a relay socket as JSON. Round-trip so tests see what a client sees. */
function overTheWire(event: SignedEvent): SignedEvent {
  return JSON.parse(JSON.stringify(event)) as SignedEvent;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

describe('wrapMessage', () => {
  it('produces one wrap for the recipient and one for the sender', () => {
    const wraps = wrapMessage(alice, bobPub, 'meet at the yard');

    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) expect(wrap.kind).toBe(KINDS.GIFT_WRAP);
    expect(giftWrapRecipient(wraps[0] as SignedEvent)).toBe(bobPub);
    expect(giftWrapRecipient(wraps[1] as SignedEvent)).toBe(alicePub);
  });

  it('signs the OUTER wrap with an ephemeral key, never the sender key', () => {
    const wraps = wrapMessage(alice, bobPub, 'burners only');

    const pubkeys = new Set<string>();
    for (const wrap of wraps) {
      expect(wrap.pubkey).not.toBe(alicePub);
      expect(wrap.pubkey).not.toBe(bobPub);
      pubkeys.add(wrap.pubkey);
    }
    // A fresh key per wrap, so the recipient's copy and the sender's copy are
    // not linkable to each other by an observer.
    expect(pubkeys.size).toBe(2);
  });

  it('randomises and backdates the outer created_at (NIP-59)', () => {
    const before = now();
    const stamps = Array.from(
      { length: 24 },
      () => (wrapMessage(alice, bobPub, 'x')[0] as SignedEvent).created_at,
    );
    const after = now();

    for (const stamp of stamps) {
      expect(stamp).toBeLessThanOrEqual(after);
      expect(stamp).toBeGreaterThanOrEqual(before - GIFT_WRAP_MAX_BACKDATE_SECONDS);
    }
    // Randomised, not "now": 24 draws over a 2-day window landing on the same
    // second has probability ~0.
    expect(new Set(stamps).size).toBeGreaterThan(1);
    expect(Math.min(...stamps)).toBeLessThan(before);
  });

  it('leaks nothing but the recipient in the plaintext tags', () => {
    const wrap = wrapMessage(alice, bobPub, 'the wall on 3rd')[0] as SignedEvent;

    // The p tag names the recipient; the only other plaintext tag is the
    // NIP-13 nonce tag, which carries no identity.
    expect(wrap.tags.filter((t) => t[0] === 'p')).toEqual([['p', bobPub]]);
    expect(wrap.tags.filter((t) => t[0] === 'nonce')).toHaveLength(1);
    expect(wrap.content).not.toContain('3rd');
    expect(JSON.stringify(wrap)).not.toContain(alicePub);
  });

  it('makes a single wrap for a note to self', () => {
    const wraps = wrapMessage(alice, alicePub, 'remember the spot');
    expect(wraps).toHaveLength(1);
    expect(unwrapMessage(alice, overTheWire(wraps[0] as SignedEvent))?.text).toBe(
      'remember the spot',
    );
  });

  it('rejects a malformed recipient or an unusable body', () => {
    expect(() => wrapMessage(alice, 'nope', 'hi')).toThrow(TypeError);
    expect(() => wrapMessage(alice, bobPub, '')).toThrow(TypeError);
    expect(() => wrapMessage(alice, bobPub, 'x'.repeat(DM_TEXT_MAX + 1))).toThrow(TypeError);
  });

  it('stays well inside the relay 64KB event cap at maximum length', () => {
    const wrap = wrapMessage(alice, bobPub, 'x'.repeat(DM_TEXT_MAX))[0] as SignedEvent;
    expect(Buffer.byteLength(JSON.stringify(wrap), 'utf8')).toBeLessThan(65_536);
  });
});

describe('wrapMessage — NIP-13 proof of work on the gift wrap', () => {
  it('mines 8 committed bits into every outer wrap (the relay default)', () => {
    const wraps = wrapMessage(alice, bobPub, 'pow wrap');

    expect(wraps.length).toBeGreaterThanOrEqual(1);
    for (const wrap of wraps) {
      expect(wrap.kind).toBe(KINDS.GIFT_WRAP);
      expect(powBits(wrap.id)).toBeGreaterThanOrEqual(8);
      expect(committedPowTarget(wrap)).toBeGreaterThanOrEqual(8);
      // The exact check the relay write-policy runs (requireCommitment:true).
      expect(hasValidPow(wrap, 8, { requireCommitment: true })).toBe(true);
    }
  });

  it('mines the single self-wrap too', () => {
    const wrap = wrapMessage(alice, alicePub, 'note to self with pow')[0] as SignedEvent;
    expect(powBits(wrap.id)).toBeGreaterThanOrEqual(8);
    expect(committedPowTarget(wrap)).toBeGreaterThanOrEqual(8);
    expect(hasValidPow(wrap, 8, { requireCommitment: true })).toBe(true);
  });

  it('verifies the outer signature after mining (real check, no memo)', () => {
    for (const wrap of wrapMessage(alice, bobPub, 'sig still good')) {
      // overTheWire drops nostr-tools' verified-symbol cache, forcing a real
      // schnorr verification against the mined id.
      expect(verifyEvent(overTheWire(wrap as SignedEvent))).toBe(true);
    }
  });

  it('round-trips through unwrap after mining', () => {
    const [forBob, forAlice] = wrapMessage(alice, bobPub, 'pow round trip');
    expect(unwrapMessage(bob, overTheWire(forBob as SignedEvent))?.text).toBe('pow round trip');
    expect(unwrapMessage(alice, overTheWire(forAlice as SignedEvent))?.text).toBe('pow round trip');
  });

  it('keeps the wrap backdated while mining (NIP-59 still holds)', () => {
    const before = now();
    const wraps = Array.from({ length: 8 }, () =>
      wrapMessage(alice, bobPub, 'backdated and mined')[0] as SignedEvent,
    );
    const after = now();

    for (const wrap of wraps) {
      // Mining never bumped the timestamp to "now" to find a hash: each wrap is
      // still in the backdated window AND carries valid committed PoW.
      expect(wrap.created_at).toBeLessThanOrEqual(after);
      expect(wrap.created_at).toBeGreaterThanOrEqual(before - GIFT_WRAP_MAX_BACKDATE_SECONDS);
      expect(hasValidPow(wrap, 8, { requireCommitment: true })).toBe(true);
    }
    // Across 8 draws the odds of every random offset flooring to 0 are
    // vanishingly small, so at least one wrap is genuinely backdated.
    expect(Math.min(...wraps.map((w) => w.created_at))).toBeLessThan(before);
  });

  it('honours a custom powBits target above the default', () => {
    const wrap = wrapMessage(alice, bobPub, 'harder', 10)[0] as SignedEvent;
    expect(powBits(wrap.id)).toBeGreaterThanOrEqual(10);
    expect(committedPowTarget(wrap)).toBeGreaterThanOrEqual(10);
    expect(hasValidPow(wrap, 10, { requireCommitment: true })).toBe(true);
  });

  it('rejects an out-of-range powBits', () => {
    expect(() => wrapMessage(alice, bobPub, 'x', -1)).toThrow(TypeError);
    expect(() => wrapMessage(alice, bobPub, 'x', 1.5)).toThrow(TypeError);
  });
});

describe('unwrapMessage — the happy paths', () => {
  it('round-trips sender -> recipient', () => {
    const sentAt = now();
    const [forBob] = wrapMessage(alice, bobPub, 'bring the fat caps');

    const opened = unwrapMessage(bob, overTheWire(forBob as SignedEvent));
    expect(opened).not.toBeNull();
    expect(opened?.senderPubkey).toBe(alicePub);
    expect(opened?.text).toBe('bring the fat caps');
    // The rumor keeps the real time; only the wrap's timestamp is a decoy.
    expect(opened?.createdAt).toBeGreaterThanOrEqual(sentAt - 1);
    expect(opened?.createdAt).toBeLessThanOrEqual(now() + 1);
  });

  it('lets the sender restore their own sent message from the self-wrap', () => {
    const [forBob, forAlice] = wrapMessage(alice, bobPub, 'same time tomorrow');

    const restored = unwrapMessage(alice, overTheWire(forAlice as SignedEvent));
    expect(restored?.text).toBe('same time tomorrow');
    expect(restored?.senderPubkey).toBe(alicePub);

    // Both wraps carry the same rumor, so the restored copy still knows who it
    // was addressed to and can be threaded into the right conversation.
    const delivered = unwrapMessage(bob, overTheWire(forBob as SignedEvent));
    expect(restored?.createdAt).toBe(delivered?.createdAt);
    expect(restored?.text).toBe(delivered?.text);
  });

  it('survives unicode and newlines intact', () => {
    const text = 'ＴＡＧ\n🖍️ — piece @ 3am\t"quotes"';
    const [forBob] = wrapMessage(alice, bobPub, text);
    expect(unwrapMessage(bob, overTheWire(forBob as SignedEvent))?.text).toBe(text);
  });
});

describe('unwrapMessage — never throws, always null', () => {
  const [forBob] = wrapMessage(alice, bobPub, 'secret');
  const wire = overTheWire(forBob as SignedEvent);

  it('returns null for the wrong recipient', () => {
    expect(unwrapMessage(mallory, wire)).toBeNull();
  });

  it('returns null for a tampered wrap', () => {
    // Ciphertext swapped for another wrap's: signature fails first, and the
    // nip44 MAC would fail even if it did not.
    const other = overTheWire(wrapMessage(alice, bobPub, 'different')[0] as SignedEvent);
    expect(unwrapMessage(bob, { ...wire, content: other.content })).toBeNull();

    // Flipped bytes inside the base64 payload.
    const flipped = wire.content.slice(0, 40) + (wire.content[40] === 'A' ? 'B' : 'A') + wire.content.slice(41);
    expect(unwrapMessage(bob, { ...wire, content: flipped })).toBeNull();

    // Re-pointed at somebody else, id/sig untouched.
    expect(unwrapMessage(bob, { ...wire, tags: [['p', getPublicKey(mallory)]] })).toBeNull();

    // Timestamp moved.
    expect(unwrapMessage(bob, { ...wire, created_at: wire.created_at + 1 })).toBeNull();
  });

  it('returns null when the memoised verification flag is smuggled in', () => {
    // nostr-tools caches "this event is valid" on a symbol property, and object
    // spread copies symbols. If we trusted that cache, this would open.
    const last = wire.content.slice(-1);
    const forged = {
      ...(forBob as SignedEvent),
      content: wire.content.slice(0, -1) + (last === 'A' ? 'B' : 'A'),
    };
    expect(forged.content).not.toBe(wire.content);
    expect(unwrapMessage(bob, forged)).toBeNull();
  });

  it('returns null for a wrap that is not kind 1059', () => {
    expect(unwrapMessage(bob, { ...wire, kind: KINDS.DM })).toBeNull();
    expect(unwrapMessage(bob, { ...wire, kind: KINDS.NOTE })).toBeNull();
  });

  it('returns null for garbage input of every shape', () => {
    for (const junk of [
      null,
      undefined,
      0,
      '',
      'not an event',
      [],
      {},
      { kind: 1059 },
      { kind: 1059, content: 'x', pubkey: 'zz', tags: [], created_at: 1, id: 'x', sig: 'y' },
      { ...wire, content: '' },
      { ...wire, content: 'A'.repeat(200_000) },
      { ...wire, pubkey: 'f'.repeat(64) },
      { ...wire, sig: '0'.repeat(128) },
      { ...wire, tags: 'not-an-array' },
      { ...wire, id: null },
    ]) {
      expect(() => unwrapMessage(bob, junk)).not.toThrow();
      expect(unwrapMessage(bob, junk)).toBeNull();
    }
  });
});

describe('giftWrapRecipient', () => {
  it('reads the public p tag and nothing else', () => {
    const [forBob] = wrapMessage(alice, bobPub, 'yo');
    expect(giftWrapRecipient(forBob as SignedEvent)).toBe(bobPub);
    expect(giftWrapRecipient({ tags: [['e', bobPub]] })).toBeNull();
    expect(giftWrapRecipient({ tags: [['p', 'short']] })).toBeNull();
    expect(giftWrapRecipient(null)).toBeNull();
  });
});
