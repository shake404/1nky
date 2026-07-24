import { getPow } from 'nostr-tools/nip13';
import type { NonceTag, PowCheckable } from './types.js';

export { minePow } from 'nostr-tools/nip13';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Number of leading zero bits in a 64-char lowercase hex event id.
 *
 * Thin wrapper over `nostr-tools/nip13`'s `getPow` that rejects malformed
 * input instead of returning a nonsense count.
 *
 * @throws TypeError if `eventId` is not 64 lowercase hex chars.
 */
export function powBits(eventId: string): number {
  if (!HEX64.test(eventId)) {
    throw new TypeError('powBits: expected a 64-char lowercase hex event id');
  }
  return getPow(eventId);
}

/**
 * The target difficulty the author committed to, per NIP-13.
 *
 * Returns `null` when there is no nonce tag or the tag carries no target,
 * and `NaN` when the target is present but unparseable (which callers must
 * treat as invalid, not as "uncommitted").
 */
export function committedPowTarget(event: PowCheckable): number | null {
  for (const tag of event.tags) {
    if (tag[0] !== 'nonce') continue;
    const target = tag[2];
    if (target === undefined || target === '') return null;
    if (!/^\d+$/.test(target)) return Number.NaN;
    return Number.parseInt(target, 10);
  }
  return null;
}

export interface PowOptions {
  /**
   * Reject events that carry no committed target difficulty at all.
   *
   * The relay write-policy should pass `true`: an uncommitted event may be a
   * spammer publishing whichever of their throwaway drafts happened to hash
   * low. Read paths can leave it `false`.
   *
   * @default false
   */
  requireCommitment?: boolean;
}

/**
 * Check an event's proof of work against a minimum difficulty.
 *
 * Enforces all three NIP-13 conditions:
 *  1. the id's actual leading-zero-bit count is at least `minBits`;
 *  2. if a target difficulty is committed in the nonce tag, that commitment
 *     is itself at least `minBits` (a lower commitment means the author never
 *     intended to meet our bar — they got lucky);
 *  3. the id actually meets the committed target.
 */
export function hasValidPow(
  event: PowCheckable,
  minBits: number,
  options: PowOptions = {},
): boolean {
  if (!Number.isInteger(minBits) || minBits < 0) {
    throw new TypeError('hasValidPow: minBits must be a non-negative integer');
  }
  if (!HEX64.test(event.id)) return false;

  const actual = getPow(event.id);
  if (actual < minBits) return false;

  const committed = committedPowTarget(event);
  if (committed === null) return options.requireCommitment !== true;
  if (!Number.isFinite(committed)) return false;
  if (committed < minBits) return false;
  if (actual < committed) return false;

  return true;
}

/** Build the NIP-13 nonce tag for a given target difficulty. */
export function powTag(nonce: number | string, targetBits: number): NonceTag {
  return ['nonce', String(nonce), String(targetBits)];
}
