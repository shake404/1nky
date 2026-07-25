/**
 * Encrypted blackbook escrow.
 *
 * The service stores ONE opaque string per tag: the NIP-49 ciphertext of that
 * tag's secret key, locked by a passphrase only the writer knows. There is no
 * key here, no plaintext, no way for this box to decrypt anything, and no
 * account — the lookup key is the tag's own pubkey and nothing else.
 *
 * Writes are authorized by a signed event from the very pubkey being escrowed,
 * so a writer can only ever escrow (or drop) their own backup. Reads are open:
 * the payload is useless without the passphrase, and requiring auth to fetch it
 * would defeat the point (you fetch it precisely when you have lost the key
 * that would sign the request).
 */
import { isBlackbookPayload } from '@1nky/protocol';

import { HttpError } from './errors.js';
import { isSha256Hex } from './http.js';

/** Distinct object-key prefix, same bucket as the blobs. */
export const ESCROW_KEY_PREFIX = 'escrow/';

/** A NIP-49 payload is ~110 chars; 4KB is generous head-room and a hard stop. */
export const ESCROW_MAX_BYTES = 4096;

export const ESCROW_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** Never cache a recovery blob — an overwrite must be visible immediately. */
export const ESCROW_CACHE_CONTROL = 'no-store';

/** Object key for a tag's escrowed blackbook. */
export function escrowKey(pubkey: string): string {
  return `${ESCROW_KEY_PREFIX}${pubkey.toLowerCase()}`;
}

/**
 * Validates a pubkey taken from the URL. A mark is 32 bytes of hex — the same
 * shape as a blob address — so the blob-path validator's rules apply.
 */
export function parseEscrowPubkey(param: string | undefined): string {
  const raw = typeof param === 'string' ? param.trim().toLowerCase() : '';
  if (!isSha256Hex(raw)) {
    throw new HttpError(400, 'that is not a valid mark');
  }
  return raw;
}

/**
 * Validates an escrow body: a single encrypted blackbook payload and nothing
 * else. Anything that is not NIP-49 ciphertext is refused, so this endpoint can
 * never be turned into a general-purpose text store.
 */
export function parseEscrowPayload(body: Buffer): string {
  if (body.length === 0) {
    throw new HttpError(400, 'escrow body is empty');
  }
  if (body.length > ESCROW_MAX_BYTES) {
    throw new HttpError(400, `escrowed blackbook exceeds the ${ESCROW_MAX_BYTES}-byte limit`);
  }
  const payload = body.toString('utf8').trim();
  if (!isBlackbookPayload(payload)) {
    throw new HttpError(400, 'body must be an encrypted blackbook');
  }
  return payload;
}
