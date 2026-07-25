import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  KINDS,
  unwrapMessage,
  wrapMessage,
  type SignedEvent,
} from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { decodeInbox, decodeWrap, dmKey } from './dm.js';

const senderSecret = generateSecretKey();
const senderPubkey = getPublicKey(senderSecret);
const recipientSecret = generateSecretKey();
const recipientPubkey = getPublicKey(recipientSecret);

function first(wraps: SignedEvent[]): SignedEvent {
  const wrap = wraps[0];
  if (!wrap) throw new Error('expected at least one wrap');
  return wrap;
}

function second(wraps: SignedEvent[]): SignedEvent {
  const wrap = wraps[1];
  if (!wrap) throw new Error('expected a second wrap');
  return wrap;
}

describe('private message round trip', () => {
  it('wraps, "publishes", receives and unwraps back to the original text', () => {
    const wraps = wrapMessage(senderSecret, recipientPubkey, 'hello walls');

    // The relay only ever sees the gift wraps — both get published.
    const published: SignedEvent[] = [...wraps];

    // The recipient receives the wrap addressed to them and opens it on-device.
    const received = decodeWrap(recipientSecret, recipientPubkey, first(published));

    expect(received).not.toBeNull();
    expect(received?.text).toBe('hello walls');
    expect(received?.senderPubkey).toBe(senderPubkey);
    expect(received?.mine).toBe(false);
  });

  it('opens the sender self-copy as mine', () => {
    const wraps = wrapMessage(senderSecret, recipientPubkey, 'copy for me');

    // wraps[1] is the sender self-copy, addressed back to the sender.
    const own = decodeWrap(senderSecret, senderPubkey, second(wraps));

    expect(own).not.toBeNull();
    expect(own?.text).toBe('copy for me');
    expect(own?.mine).toBe(true);
  });

  it('produces a single wrap when messaging yourself', () => {
    const wraps = wrapMessage(senderSecret, senderPubkey, 'note to self');
    expect(wraps).toHaveLength(1);
    const opened = decodeWrap(senderSecret, senderPubkey, first(wraps));
    expect(opened?.text).toBe('note to self');
    expect(opened?.mine).toBe(true);
  });

  it('send -> receive renders the same text end to end', () => {
    // sendMessage publishes through the relay; here we exercise the wrap path
    // directly so no socket is needed, then unwrap exactly what was published.
    const published = wrapMessage(senderSecret, recipientPubkey, 'seen on the 3rd');
    const decoded = decodeWrap(recipientSecret, recipientPubkey, first(published));

    expect(decoded?.text).toBe('seen on the 3rd');
    expect(decoded).not.toBeNull();
    if (decoded) {
      expect(dmKey(decoded)).toBe(
        dmKey({ senderPubkey: senderPubkey, createdAt: decoded.createdAt, text: 'seen on the 3rd' }),
      );
    }
  });
});

describe('unwrappable messages are dropped', () => {
  it('returns null for a wrap addressed to somebody else', () => {
    const thirdSecret = generateSecretKey();
    const thirdPubkey = getPublicKey(thirdSecret);

    // Sealed and wrapped for a third party — not for the recipient.
    const notForMe = first(wrapMessage(senderSecret, thirdPubkey, 'private to them'));

    expect(decodeWrap(recipientSecret, recipientPubkey, notForMe)).toBeNull();
  });

  it('returns null for something that is not a gift wrap at all', () => {
    const note = finalizeEvent(
      { kind: KINDS.NOTE, tags: [], content: 'plain text', created_at: 1 },
      senderSecret,
    );
    expect(decodeWrap(recipientSecret, recipientPubkey, note)).toBeNull();
  });

  it('returns null when the underlying unwrap fails', () => {
    // A kind-1059-shaped object with garbage content: unwrapMessage rejects it.
    const junk = finalizeEvent(
      { kind: KINDS.GIFT_WRAP, tags: [['p', recipientPubkey]], content: 'not ciphertext', created_at: 1 },
      senderSecret,
    );
    expect(unwrapMessage(recipientSecret, junk)).toBeNull();
    expect(decodeWrap(recipientSecret, recipientPubkey, junk)).toBeNull();
  });

  it('decodeInbox keeps only the wraps that really are ours', () => {
    const good = first(wrapMessage(senderSecret, recipientPubkey, 'real one'));
    const note = finalizeEvent(
      { kind: KINDS.NOTE, tags: [], content: 'noise', created_at: 2 },
      senderSecret,
    );
    const someoneElses = first(
      wrapMessage(senderSecret, getPublicKey(generateSecretKey()), 'not yours'),
    );

    const kept = decodeInbox(recipientSecret, recipientPubkey, [good, note, someoneElses]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe('real one');
  });
});
