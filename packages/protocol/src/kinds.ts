/**
 * Nostr event kinds used by 1NKY.
 *
 * This is the single source of truth for kind numbers across the relay
 * write-policy, the indexer, the API and the web client. Never inline a
 * numeric kind anywhere else.
 */
export const KINDS = {
  /** NIP-01 profile metadata — the writer's tag, city, avatar hash. */
  PROFILE: 0,
  /** NIP-01 text note — thread OPs on boards. */
  NOTE: 1,
  /** NIP-09 deletion request — user-facing copy: "buff". */
  DELETE: 5,
  /** NIP-68 picture event — user-facing copy: "flick". */
  FLICK: 20,
  /** NIP-22 comment — replies on flicks and thread posts. */
  COMMENT: 1111,
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

/** Every kind 1NKY publishes or accepts, for relay write-policy allowlists. */
export const ALL_KINDS: readonly number[] = Object.freeze(Object.values(KINDS));

/** True when `kind` is one of the kinds 1NKY understands. */
export function isKnownKind(kind: number): kind is Kind {
  return ALL_KINDS.includes(kind);
}
