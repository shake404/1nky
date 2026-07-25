import {
  DM_TEXT_MAX,
  giftWrapRecipient,
  unwrapMessage,
  wrapMessage,
  type SignedEvent,
} from '@1nky/protocol';
import { relay } from './relay.js';
import type { Tag } from './identity.js';

/**
 * Private messages — the device-only read/write path.
 *
 * Encryption and decryption happen exclusively on this device, through the
 * frozen `@1nky/protocol` helpers. Plaintext never travels further than the
 * screen. Decrypted messages live in memory / IndexedDB here, never on a
 * server: the relay only ever sees kind-1059 gift wraps.
 */

/** A decrypted private message, ready to render. */
export interface DecodedDm {
  /** Who actually sent it (verified by the seal signature). */
  senderPubkey: string;
  text: string;
  createdAt: number;
  /** True when this is our own sent copy (the self-wrap). */
  mine: boolean;
}

/**
 * Open a gift wrap addressed to us.
 *
 * Returns null for anything that is not ours to read: a wrap addressed to
 * somebody else, a tampered wrap, a wrong kind, a bad signature. It never
 * throws — the input is an arbitrary blob handed over by a stranger.
 */
export function decodeWrap(
  mySecret: Uint8Array,
  myPubkey: string,
  wrap: SignedEvent,
): DecodedDm | null {
  if (giftWrapRecipient(wrap) !== myPubkey) return null;
  const opened = unwrapMessage(mySecret, wrap);
  if (opened === null) return null;
  return { ...opened, mine: opened.senderPubkey === myPubkey };
}

/**
 * Run a batch of wraps through the decryptor and keep only the ones that
 * really are ours. Anything that unwraps to null is dropped on the floor.
 */
export function decodeInbox(
  mySecret: Uint8Array,
  myPubkey: string,
  wraps: readonly SignedEvent[],
): DecodedDm[] {
  const out: DecodedDm[] = [];
  for (const wrap of wraps) {
    const decoded = decodeWrap(mySecret, myPubkey, wrap);
    if (decoded !== null) out.push(decoded);
  }
  return out;
}

/**
 * Wrap, then publish every gift wrap that comes back.
 *
 * `wrapMessage` returns both the recipient's copy and our own self-copy (so
 * we can restore sent messages later). Both are already signed by one-shot
 * ephemeral keys and published as-is — the relay only ever stores the wraps.
 */
export async function sendMessage(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  recipientPubkey: string,
  text: string,
): Promise<SignedEvent[]> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Say something first.');
  if (trimmed.length > DM_TEXT_MAX) {
    throw new Error(`Keep it under ${DM_TEXT_MAX} characters.`);
  }

  const wraps = wrapMessage(tag.secret, recipientPubkey, trimmed);
  await Promise.all(wraps.map((wrap) => relay.publish(wrap)));
  return wraps;
}

/** Stable key for deduping the same message arriving twice. */
export function dmKey(message: Pick<DecodedDm, 'senderPubkey' | 'createdAt' | 'text'>): string {
  return `${message.senderPubkey}:${message.createdAt}:${message.text}`;
}
