import { hasValidPow, minePow, type EventTemplate, type UnsignedEvent } from '@1nky/protocol';

/**
 * The mining step, isolated from any worker plumbing so it can be tested
 * (and, in a pinch, run on the main thread) directly.
 */

export interface PowRequest {
  /** Correlation id so one worker can serve overlapping requests. */
  job: string;
  template: EventTemplate;
  /** Author's hex pubkey — it is part of the hashed preimage. */
  pubkey: string;
  /** Target difficulty in leading zero bits. */
  bits: number;
}

export type PowResponse =
  | { job: string; ok: true; event: UnsignedEvent & { id: string } }
  | { job: string; ok: false; error: string };

/**
 * Mine a committed-target nonce onto a template.
 *
 * `minePow` mutates the object it is handed and rewrites `created_at` as it
 * goes, so we hand it a private copy and return whatever it settled on. The
 * caller must sign exactly these tags and this timestamp or the id changes
 * and the work is thrown away.
 */
export function mineTemplate(request: PowRequest): UnsignedEvent & { id: string } {
  const { template, pubkey, bits } = request;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new TypeError('bits must be an integer between 0 and 32');
  }

  const draft: UnsignedEvent = {
    kind: template.kind,
    tags: template.tags.map((tag) => [...tag]),
    content: template.content,
    created_at: template.created_at,
    pubkey,
  };

  // Difficulty 0 still gets a committed nonce tag: the write policy is
  // entitled to demand a commitment on every event we send.
  const mined = minePow(draft, bits) as UnsignedEvent & { id: string };

  if (!hasValidPow(mined, bits, { requireCommitment: true })) {
    throw new Error('work did not verify');
  }
  return mined;
}
