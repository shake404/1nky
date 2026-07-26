/**
 * Nostr event kinds used by 1NKY.
 *
 * This is the single source of truth for kind numbers across the relay
 * write-policy, the indexer, the API and the web client. Never inline a
 * numeric kind anywhere else.
 */
export const KINDS = {
  /** NIP-01 profile metadata — the writer's tag, city, bio, avatar hash. */
  PROFILE: 0,
  /** NIP-01 text note — thread OPs on boards. */
  NOTE: 1,
  /** NIP-09 deletion request — user-facing copy: "buff". */
  DELETE: 5,
  /**
   * NIP-59 seal. WRAP-INTERNAL: the sender-signed envelope that lives
   * *encrypted inside* a gift wrap. It is never transmitted on its own and the
   * relay must refuse it — see `WRAP_INTERNAL_KINDS`.
   */
  SEAL: 13,
  /**
   * NIP-17 private direct message ("rumor"). WRAP-INTERNAL: an unsigned event
   * that only ever exists encrypted inside a seal, inside a gift wrap. A naked
   * kind 14 arriving at the relay is a plaintext DM leak, not a message.
   */
  DM: 14,
  /** NIP-68 picture event — user-facing copy: "flick". */
  FLICK: 20,
  /** NIP-71 short-form video — user-facing copy: "flick" (video). */
  VIDEO: 22,
  /**
   * NIP-59 gift wrap. This is the ONLY private-message kind that goes on the
   * wire: signed by a throwaway ephemeral key, `p`-tagged to the recipient,
   * with a randomised/backdated `created_at`.
   */
  GIFT_WRAP: 1059,
  /** NIP-22 comment — replies on flicks and thread posts. */
  COMMENT: 1111,
  /**
   * An **amendment**: tags the author adds to something they already put up.
   * User-facing copy: "Add to this" (never "edit").
   *
   * 1NKY's one non-standard kind, and the number is chosen on purpose:
   *
   *   - It sits in the NIP-01 **regular** range (1000-9999), so a relay stores
   *     every amendment rather than replacing the previous one. That is
   *     load-bearing, not incidental: amendments are ADD-ONLY, and the read
   *     model is the set-union of the original's tags with every amendment's.
   *     A replaceable kind (10000+/30000+) would let the relay drop all but the
   *     newest, and a rebuild would then lose whatever the earlier ones added.
   *   - It is adjacent to 1111 (NIP-22 comment) because it is the same sort of
   *     thing: a signed pointer at somebody's own earlier event. Nothing in any
   *     NIP claims 1113, and 1NKY never publishes to public relays (see
   *     CLAUDE.md "Do NOT"), so the only allowlist it has to agree with is our
   *     own — ALLOWED_KINDS in infra/strfry/write-policy.mjs.
   *
   * Why an amendment exists at all: events are signed and immutable, and every
   * comment references the original's id. Buffing and reposting to fix a missing
   * wall would orphan the whole conversation, so the fix is additive — a second
   * signed event by the SAME author carrying the tags that were missing. The
   * original is never touched, and only the original author's amendment counts
   * (the indexer enforces that at read time; see `applyAmendment`).
   */
  AMENDMENT: 1113,
  /** NIP-56 report — user-facing copy: "flag it". */
  REPORT: 1984,
  /** NIP-51 mute list — user-facing copy: "ignore this writer". */
  MUTE_LIST: 10000,
  /** NIP-78 arbitrary app data — crew definitions, board registry. */
  APP_DATA: 30078,
  /** Blossom BUD-01 upload authorization event. */
  BLOSSOM_AUTH: 24242,
} as const;

export type KindName = keyof typeof KINDS;

/** Union of every kind number 1NKY knows about. */
export type Kind = (typeof KINDS)[KindName];

/**
 * Kinds that exist ONLY encrypted inside a NIP-59 gift wrap.
 *
 * These are deliberately absent from `ALL_KINDS`. The relay write-policy
 * rejects them outright: a kind 13 or kind 14 that reached a relay socket was
 * never wrapped, which means its content is a private message in the clear.
 * Rejecting is the privacy-preserving behaviour, not the strict one.
 */
export const WRAP_INTERNAL_KINDS: readonly number[] = Object.freeze([KINDS.SEAL, KINDS.DM]);

/**
 * Every kind 1NKY publishes or accepts **on the wire**, anywhere.
 *
 * Wrap-internal kinds are excluded by construction: they are not wire kinds.
 * Gift wraps (1059) are included because the relay really does store and serve
 * them. Blossom auth (24242) is included because clients really do produce it
 * — but it travels in an HTTP `Authorization` header to the media service, not
 * to the relay, which is why `RELAY_ACCEPTED_KINDS` is a narrower list.
 */
export const ALL_KINDS: readonly number[] = Object.freeze(
  Object.values(KINDS).filter((kind) => !WRAP_INTERNAL_KINDS.includes(kind)),
);

/**
 * The relay write-policy allowlist: exactly the kinds strfry accepts from a
 * client. Mirrored by `ALLOWED_KINDS` in infra/strfry/write-policy.mjs, and
 * held to it by `relay-policy.test.ts`.
 *
 * Two deliberate differences from `ALL_KINDS`:
 *   - 13 / 14 are absent (see `WRAP_INTERNAL_KINDS`) — accepting either would
 *     mean storing a private message in the clear.
 *   - 24242 is absent: a Blossom upload authorisation is a request credential
 *     for the media service, not content, and has no business being published.
 */
export const RELAY_ACCEPTED_KINDS: readonly number[] = Object.freeze(
  ALL_KINDS.filter((kind) => kind !== KINDS.BLOSSOM_AUTH),
);

/** True when `kind` only ever appears inside a gift wrap (13, 14). */
export function isWrapInternalKind(kind: number): boolean {
  return WRAP_INTERNAL_KINDS.includes(kind);
}

/**
 * True when `kind` is one of the kinds 1NKY understands.
 *
 * Includes the wrap-internal kinds: the DM helpers have to recognise a seal
 * and a rumor after decrypting them. Use `isRelayAcceptedKind` for the
 * "may this arrive at the relay?" question.
 */
export function isKnownKind(kind: number): kind is Kind {
  return (Object.values(KINDS) as readonly number[]).includes(kind);
}

/** True when the relay accepts `kind` from a client. */
export function isRelayAcceptedKind(kind: number): boolean {
  return RELAY_ACCEPTED_KINDS.includes(kind);
}
