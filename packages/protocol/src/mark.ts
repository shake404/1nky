import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8Encoder } from 'nostr-tools/utils';

/**
 * Crockford-style base32: lowercase, no `i`, `l`, `o`, `u`. Chosen so a mark
 * can be read aloud, copied off a phone screen, or written in a blackbook
 * without ambiguity.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Length of a mark in characters. 6 chars of base32 = 30 bits. */
export const MARK_LENGTH = 6;

const DOMAIN = utf8Encoder.encode('1nky:mark:v1');
const HEX64 = /^[0-9a-f]{64}$/;

const cache = new Map<string, Uint8Array>();
const CACHE_LIMIT = 512;

/** Domain-separated digest of a pubkey, memoised. Never equals an event id. */
function markDigest(pubkey: string): Uint8Array {
  if (!HEX64.test(pubkey)) {
    throw new TypeError('expected a 64-char lowercase hex pubkey');
  }
  const hit = cache.get(pubkey);
  if (hit) return hit;

  const raw = hexToBytes(pubkey);
  const input = new Uint8Array(DOMAIN.length + raw.length);
  input.set(DOMAIN, 0);
  input.set(raw, DOMAIN.length);
  const digest = sha256(input);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(pubkey, digest);
  return digest;
}

/**
 * A writer's **mark**: a stable 6-char lowercase fingerprint of their pubkey.
 *
 * Tag names are not unique — there is no registrar — so every place a tag is
 * shown, the mark is shown beside it. "same name, different mark = different
 * writer" (`COPY.mark.hint`).
 *
 * Stable forever for a given pubkey; changing this function would silently
 * repaint every writer's identity, so treat it as frozen.
 *
 * @throws TypeError if `pubkey` is not 64 lowercase hex chars.
 */
export function fingerprint(pubkey: string): string {
  const digest = markDigest(pubkey);
  let out = '';
  // 6 chars x 5 bits = 30 bits, read big-endian off the front of the digest.
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < MARK_LENGTH) {
    if (bits < 5) {
      acc = (acc << 8) | (digest[i++] ?? 0);
      bits += 8;
    }
    bits -= 5;
    out += ALPHABET[(acc >>> bits) & 0b11111];
  }
  return out;
}

/**
 * A 32-bit unsigned integer seeded from the pubkey, for deterministic
 * identicon generation. Independent of `fingerprint`'s bits so two writers
 * with visually similar identicons will not also share a mark prefix.
 */
export function identiconSeed(pubkey: string): number {
  const digest = markDigest(pubkey);
  return (
    (((digest[8] ?? 0) << 24) |
      ((digest[9] ?? 0) << 16) |
      ((digest[10] ?? 0) << 8) |
      (digest[11] ?? 0)) >>>
    0
  );
}

/** True when two pubkeys collide on the same mark (same tag, same mark risk). */
export function sameMark(a: string, b: string): boolean {
  return fingerprint(a) === fingerprint(b);
}
