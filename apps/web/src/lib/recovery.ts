import { decryptBlackbook, encryptBlackbook, finalizeEvent, KINDS, type EventTemplate } from '@1nky/protocol';
import { MEDIA_BASE } from './config.js';
import { authHeader } from './flicks.js';

/**
 * Recovery: a locked copy of the blackbook, kept somewhere that is not this
 * phone.
 *
 * The trade is deliberately narrow and deliberately opt-in. What gets stored is
 * the SAME passphrase-locked payload the writer downloads as their blackbook —
 * nothing else, and nothing that could open it. The passphrase is used here, on
 * the device, and never sent. So the wall holds a box it cannot open, addressed
 * by nothing but the tag's own mark: no name, no number, no account, and no way
 * to answer "whose is this" beyond the mark itself.
 *
 * That means the promise in the copy deck survives intact. Lose the file AND the
 * passphrase and the tag is gone, exactly as before — a locked copy of something
 * unopenable is not a back door, and there is nobody to ask.
 *
 * Every call here is against endpoints that may not exist: the service ships with
 * the feature dark and answers 404 until an operator turns it on. A 404 is
 * therefore a specific, expected answer with its own message, not a failure.
 */

/** What the service says when recovery is not switched on. */
export class RecoveryDarkError extends Error {
  constructor() {
    super('Recovery is not switched on yet.');
  }
}

/** No locked copy stored for that mark. */
export class NoLockedCopyError extends Error {
  constructor() {
    super('No locked copy for that mark.');
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Prove control of the tag whose locked copy is being stored or dropped.
 *
 * The identical mechanism an upload uses (a signed, short-lived, single-purpose
 * event in the `Authorization` header), with `escrow` as the action instead of
 * `upload`. There is no `x` here because there is no blob address involved: the
 * signer IS the subject, which is what stops anybody storing a copy under
 * somebody else's mark.
 */
export function buildRecoveryAuth(now = Math.floor(Date.now() / 1000)): EventTemplate {
  return {
    kind: KINDS.BLOSSOM_AUTH,
    created_at: now,
    tags: [
      ['t', 'escrow'],
      ['expiration', String(now + 300)],
    ],
    content: 'Keep a locked copy',
  };
}

/**
 * Lock the tag's secret with a passphrase, ready to be stored.
 *
 * Split out from the request so the one thing that must never go wrong — that
 * what leaves the device is ciphertext and not the secret — is testable without
 * a network in the room.
 */
export function lockedCopy(secret: Uint8Array, passphrase: string, logn?: number): string {
  const trimmed = passphrase.trim();
  if (!trimmed) throw new Error('Pick a passphrase first.');
  return encryptBlackbook(secret, trimmed, logn === undefined ? {} : { logn });
}

/** The link a writer saves so they can point at their locked copy later. */
export function recoveryHandle(pubkey: string, origin?: string): string {
  const path = `/w/${pubkey.toLowerCase()}`;
  const base = (origin ?? (typeof location === 'undefined' ? '' : location.origin)).replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

/**
 * `PUT {MEDIA_BASE}/escrow` — store (or replace) the locked copy.
 *
 * The body is the ciphertext string and nothing else. The service refuses
 * anything that is not a locked blackbook, which is what keeps this from
 * quietly becoming a place to leave notes.
 */
export async function putLockedCopy(
  secret: Uint8Array,
  ciphertext: string,
  signal?: AbortSignal,
): Promise<void> {
  const auth = finalizeEvent(buildRecoveryAuth(), secret);
  const response = await fetch(`${MEDIA_BASE}/escrow`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: ciphertext,
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) throw new RecoveryDarkError();
  if (!response.ok) throw new Error('That did not save. Try again.');
}

/**
 * `GET {MEDIA_BASE}/escrow/:pubkey` — fetch a locked copy back.
 *
 * No proof of anything is asked for, and that is the point: you come here
 * precisely when you have lost the thing you would have signed with. The payload
 * is useless without the passphrase.
 */
export async function fetchLockedCopy(pubkey: string, signal?: AbortSignal): Promise<string> {
  const mark = pubkey.trim().toLowerCase();
  if (!HEX64.test(mark)) throw new NoLockedCopyError();

  const response = await fetch(`${MEDIA_BASE}/escrow/${mark}`, {
    headers: { Accept: 'text/plain' },
    ...(signal ? { signal } : {}),
  });
  // A dark service and a mark with nothing stored both answer 404, and from out
  // here they are the same fact: there is no locked copy to be had.
  if (response.status === 404) throw new NoLockedCopyError();
  if (!response.ok) throw new Error('Could not reach the wall. Try again.');

  const payload = (await response.text()).trim();
  if (!payload) throw new NoLockedCopyError();
  return payload;
}

/** `DELETE {MEDIA_BASE}/escrow` — drop the locked copy for good. */
export async function dropLockedCopy(secret: Uint8Array, signal?: AbortSignal): Promise<void> {
  const auth = finalizeEvent(buildRecoveryAuth(), secret);
  const response = await fetch(`${MEDIA_BASE}/escrow`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(auth) },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) throw new NoLockedCopyError();
  if (!response.ok) throw new Error('That did not come down. Try again.');
}

/**
 * The whole way back: fetch the locked copy for a mark and open it.
 *
 * @throws `NoLockedCopyError` when there is nothing stored, or a plain
 *         "Wrong passphrase." when there is and it will not open — the two are
 *         genuinely different situations and reading one as the other sends
 *         somebody hunting for a file they still have.
 */
export async function openLockedCopy(
  pubkey: string,
  passphrase: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const payload = await fetchLockedCopy(pubkey, signal);
  try {
    return decryptBlackbook(payload, passphrase);
  } catch {
    throw new Error('Wrong passphrase.');
  }
}
