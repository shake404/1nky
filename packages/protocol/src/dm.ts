/**
 * Private messages — NIP-17 (`kind 14`) sealed with NIP-59 (`kind 13`) and
 * gift-wrapped (`kind 1059`).
 *
 * WHAT GOES ON THE WIRE
 *   Only the kind-1059 gift wrap. It is signed by a one-shot ephemeral key
 *   that is generated, used once and thrown away, `p`-tagged to the recipient,
 *   and stamped with a `created_at` randomly backdated by up to two days. So
 *   the relay learns: "somebody sent something to this pubkey, at some point
 *   in the last 48 hours". It does not learn who, when, or what.
 *
 *   The kind-13 seal and the kind-14 rumor NEVER appear unencrypted. They are
 *   absent from `ALL_KINDS` and the relay write-policy rejects them by number
 *   — a naked kind 14 on a relay socket is a plaintext DM, not a message.
 *
 * WHAT THIS INDEX NEVER SEES
 *   Gift wraps are not indexed into Postgres (see apps/indexer). They live in
 *   the relay only, where a client fetches its own by `#p` filter.
 *
 * ALL CRYPTO IS nostr-tools / @noble. Nothing here is hand-rolled: this module
 * is composition plus the validation nostr-tools deliberately leaves to the
 * caller.
 */

import { createRumor, createSeal } from 'nostr-tools/nip59';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';

import { KINDS } from './kinds.js';
import { powBits as countPowBits, powTag } from './pow.js';
import type { SignedEvent, UnsignedEvent } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** Longest message body accepted, in characters. */
export const DM_TEXT_MAX = 8192;

/**
 * How far a gift wrap's `created_at` may be backdated (NIP-59 uses up to two
 * days). Anything outside `[now - this, now + skew]` is not a wrap we made.
 */
export const GIFT_WRAP_MAX_BACKDATE_SECONDS = 2 * 24 * 60 * 60;

/**
 * Ciphertext size ceiling, applied before handing a payload to nip44.
 * nostr-tools' `nip44.decrypt` documents that oversized input is the caller's
 * problem; this is that check. Matches the relay's 64KB event cap.
 */
const MAX_CIPHERTEXT_CHARS = 65_536;

function assertPubkey(value: string, what: string): string {
  if (!HEX64.test(value)) {
    throw new TypeError(`${what}: expected 64-char lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Randomised, backdated `created_at` for a gift wrap (NIP-59: up to two days
 * old). Floored so the stamp can never sit above `now` and trip a freshness
 * check downstream.
 */
function randomBackdatedCreatedAt(): number {
  return Math.floor(Date.now() / 1000 - Math.random() * GIFT_WRAP_MAX_BACKDATE_SECONDS);
}

/**
 * Mine a NIP-13 committed-target proof of work into an unsigned gift-wrap
 * template, grinding the nonce counter only so the wrap's NIP-59 backdated
 * `created_at` is preserved.
 *
 * Returns the template with a `["nonce", n, target]` tag appended and its
 * `id` set to a hash with at least `targetBits` leading zero bits; the
 * committed target equals `targetBits`, so `hasValidPow(_, targetBits,`
 * `{requireCommitment:true})` holds. The id is computed with `getEventHash`,
 * the same serialisation `finalizeEvent` uses, so a later signature on the
 * same four fields reproduces it exactly.
 */
function mineGiftWrapPow(
  template: UnsignedEvent,
  targetBits: number,
): UnsignedEvent & { id: string } {
  const nonceTag = powTag(0, Math.max(0, targetBits));
  const event: UnsignedEvent = {
    pubkey: template.pubkey,
    kind: template.kind,
    content: template.content,
    created_at: template.created_at,
    tags: [...template.tags, nonceTag],
  };
  let nonce = 0;
  let id = getEventHash(event);
  while (countPowBits(id) < targetBits) {
    nonce += 1;
    nonceTag[1] = String(nonce);
    id = getEventHash(event);
  }
  return { ...event, id };
}

/**
 * Build one PoW-mined kind-1059 gift wrap delivering `rumor` to
 * `recipientPubkey`.
 *
 * The seal (kind 13) is signed by the sender and needs no PoW — it never
 * touches the relay. Only the outer 1059 is mined, and it is signed by a
 * one-shot ephemeral key generated here, so the nonce can be ground before
 * signing. NIP-59 conventions hold: the only plaintext `p` tag names the
 * recipient, the recipient is hidden inside the ciphertext, and the
 * `created_at` is randomly backdated.
 */
function giftWrapWithPow(
  rumor: ReturnType<typeof createRumor>,
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  targetBits: number,
): SignedEvent {
  const seal = createSeal(rumor, senderSecretKey, recipientPubkey);

  const ephemeralSecretKey = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralSecretKey);
  const content = nip44Encrypt(
    JSON.stringify(seal),
    getConversationKey(ephemeralSecretKey, recipientPubkey),
  );

  const mined = mineGiftWrapPow(
    {
      pubkey: ephemeralPubkey,
      kind: KINDS.GIFT_WRAP,
      content,
      created_at: randomBackdatedCreatedAt(),
      tags: [['p', recipientPubkey]],
    },
    targetBits,
  );

  return finalizeEvent(
    { kind: mined.kind, tags: mined.tags, content: mined.content, created_at: mined.created_at },
    ephemeralSecretKey,
  );
}

/**
 * Send `text` privately.
 *
 * Returns the gift wraps to publish, **all of them**:
 *   `[0]` addressed to `recipientPubkey` — the message being delivered.
 *   `[1]` addressed back to the sender — how the sender restores their own
 *         sent messages later, since they cannot decrypt `[0]`.
 * When the sender messages themselves there is only one wrap.
 *
 * Both wraps carry the *same* kind-14 rumor, whose `p` tag names the
 * recipient. (`nip17.wrapManyEvents` rewrites that tag per recipient, so the
 * sender's own copy would say "to: me" and the conversation it belonged to
 * would be unrecoverable. We wrap one shared rumor instead — same NIP-17
 * shape on the recipient's side, useful on ours.)
 *
 * Each returned wrap has its own freshly generated ephemeral pubkey, so the
 * two are unlinkable to an observer.
 *
 * Each outer wrap carries a NIP-13 proof of work mined into it before it is
 * signed with its ephemeral key: a `["nonce", n, powBits]` tag committed to
 * `powBits` (default 8, matching the relay's `POW_BITS_REACTION`), and an id
 * with at least that many leading zero bits. Without it the relay write-policy
 * rejects kind 1059 and private messages silently fail to send. The seal and
 * rumor are unchanged — only the outer envelope is mined.
 */
export function wrapMessage(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  text: string,
  powBits: number = 8,
): SignedEvent[] {
  assertPubkey(recipientPubkey, 'wrapMessage(recipientPubkey)');
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('wrapMessage: text must not be empty');
  }
  if (text.length > DM_TEXT_MAX) {
    throw new TypeError(`wrapMessage: text must be at most ${DM_TEXT_MAX} characters`);
  }
  if (!Number.isInteger(powBits) || powBits < 0) {
    throw new TypeError('wrapMessage: powBits must be a non-negative integer');
  }

  const senderPubkey = getPublicKey(senderSecretKey);

  // The NIP-17 rumor. Unsigned by design — an unsigned event cannot be
  // forwarded as proof of who said what. `created_at` is pinned here so both
  // wraps carry a byte-identical rumor (and therefore the same rumor id).
  const rumor = createRumor(
    {
      kind: KINDS.DM,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: text,
    },
    senderSecretKey,
  );

  const wraps: SignedEvent[] = [giftWrapWithPow(rumor, senderSecretKey, recipientPubkey, powBits)];
  if (recipientPubkey !== senderPubkey) {
    wraps.push(giftWrapWithPow(rumor, senderSecretKey, senderPubkey, powBits));
  }
  return wraps;
}

/** A decrypted private message. */
export interface UnwrappedMessage {
  /** Who actually signed the seal. Verified, not merely claimed. */
  senderPubkey: string;
  /** The message body. */
  text: string;
  /** The rumor's timestamp — the real one, not the wrap's decoy. */
  createdAt: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * nip44-decrypt `payload` and JSON.parse it. Returns null rather than throwing
 * on any failure: bad size, bad base64, bad MAC, bad JSON, wrong key.
 */
function openLayer(
  payload: unknown,
  secretKey: Uint8Array,
  counterpartyPubkey: unknown,
): Record<string, unknown> | null {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  if (payload.length > MAX_CIPHERTEXT_CHARS) return null;
  if (typeof counterpartyPubkey !== 'string' || !HEX64.test(counterpartyPubkey)) return null;

  let plaintext: string;
  try {
    plaintext = nip44Decrypt(payload, getConversationKey(secretKey, counterpartyPubkey));
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(plaintext);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Check a signature without trusting the object handed to us.
 *
 * `nostr-tools` memoises verification on a symbol-keyed property of the event.
 * That property survives object spread, so `{ ...wrap, content: evil }` would
 * otherwise sail through `verifyEvent`. Copying the seven canonical fields
 * onto a bare object drops the memo and forces a real check.
 */
function hasValidSignature(event: Record<string, unknown>): boolean {
  const candidate = {
    id: event['id'],
    pubkey: event['pubkey'],
    created_at: event['created_at'],
    kind: event['kind'],
    tags: event['tags'],
    content: event['content'],
    sig: event['sig'],
  };
  try {
    return verifyEvent(candidate as unknown as SignedEvent);
  } catch {
    return false;
  }
}

/**
 * Open a gift wrap addressed to us.
 *
 * Returns `null` for anything that is not a message we can trust — wrong kind,
 * bad signature, not addressed to this key, tampered ciphertext, a seal whose
 * signer disagrees with the rumor's claimed author. It NEVER throws: the input
 * is an arbitrary blob handed over by a stranger via a relay.
 *
 * Beyond what `nip59.unwrapEvent` does, this checks:
 *   - the wrap really is kind 1059 and its signature is valid;
 *   - the inner event really is a kind-13 seal and its signature is valid,
 *     which is the only thing that authenticates the sender;
 *   - the rumor is kind 14 and its `pubkey` matches the seal's signer, so a
 *     sealer cannot attribute a message to somebody else.
 */
export function unwrapMessage(
  recipientSecretKey: Uint8Array,
  wrap: unknown,
): UnwrappedMessage | null {
  if (!isObject(wrap)) return null;
  if (wrap['kind'] !== KINDS.GIFT_WRAP) return null;
  if (!hasValidSignature(wrap)) return null;

  // Signed by the ephemeral key; that key is also the nip44 counterparty.
  const seal = openLayer(wrap['content'], recipientSecretKey, wrap['pubkey']);
  if (seal === null) return null;
  if (seal['kind'] !== KINDS.SEAL) return null;
  if (!hasValidSignature(seal)) return null;

  const sealer = seal['pubkey'];
  if (typeof sealer !== 'string' || !HEX64.test(sealer)) return null;

  const rumor = openLayer(seal['content'], recipientSecretKey, sealer);
  if (rumor === null) return null;
  if (rumor['kind'] !== KINDS.DM) return null;
  // The rumor is unsigned, so its `pubkey` is a claim. The seal's signature is
  // the proof. If they disagree, somebody is trying to put words in a mouth.
  if (rumor['pubkey'] !== sealer) return null;

  const text = rumor['content'];
  const createdAt = rumor['created_at'];
  if (typeof text !== 'string') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;

  return { senderPubkey: sealer, text, createdAt };
}

/**
 * Who a gift wrap is addressed to, from its public `p` tag. This is the only
 * thing about a wrap that is readable without the recipient's key — it is what
 * the relay filters on.
 */
export function giftWrapRecipient(wrap: unknown): string | null {
  if (!isObject(wrap)) return null;
  const tags = wrap['tags'];
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'p') continue;
    const value: unknown = tag[1];
    if (typeof value === 'string' && HEX64.test(value)) return value;
  }
  return null;
}
