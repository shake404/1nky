import type { Event, EventTemplate, UnsignedEvent, VerifiedEvent } from 'nostr-tools/pure';

export type {
  /** Event with a pubkey but no `id`/`sig` yet (nostr-tools shape). */
  UnsignedEvent,
  /** `{ kind, tags, content, created_at }` — what every builder here returns. */
  EventTemplate,
  /** A signature-checked event (branded by nostr-tools' `verifyEvent`). */
  VerifiedEvent,
};

/** A fully-formed signed event: `{ id, pubkey, created_at, kind, tags, content, sig }`. */
export type SignedEvent = Event;

/** A raw Nostr tag. */
export type Tag = string[];

/** `["t", "<board-slug>"]` — board / city membership (NIP-12 style hashtag). */
export type BoardTag = ['t', string];

/** `["expiration", "<unix-seconds>"]` — NIP-40, powers ephemeral "beef" threads. */
export type ExpirationTag = ['expiration', string];

/** `["nonce", "<nonce>", "<committed-target-bits>"]` — NIP-13. */
export type NonceTag = ['nonce', string, string] | ['nonce', string];

/** Pixel dimensions of a flick's image. */
export interface FlickDims {
  width: number;
  height: number;
}

/**
 * The media description carried in a kind-20 `imeta` tag (NIP-92).
 * `sha256` is the Blossom blob address — the image's identity.
 */
export interface FlickImeta {
  /** Absolute URL the blob is served from. */
  url: string;
  /** Lowercase hex SHA-256 of the served bytes (the `x` value). */
  sha256: string;
  /** Pixel dimensions, serialised as `dim <w>x<h>`. */
  dims: FlickDims;
  /** Blurhash placeholder shown while the image loads. */
  blurhash?: string;
  /** Accessibility description. */
  alt?: string;
  /** MIME type of the served bytes. Defaults to `image/webp`. */
  mime?: string;
  /** Byte length of the served bytes. */
  size?: number;
}

/** The subset of an event needed to check its proof of work. */
export interface PowCheckable {
  id: string;
  tags: string[][];
}

/** A comment / report anchor: an event plus the metadata NIP-22 needs. */
export interface EventRef {
  id: string;
  pubkey: string;
  kind: number;
  /** Optional relay hint. 1NKY is single-relay so this is usually omitted. */
  relay?: string;
}

/** NIP-56 report reasons. */
export type ReportReason =
  | 'nudity'
  | 'malware'
  | 'profanity'
  | 'illegal'
  | 'spam'
  | 'impersonation'
  | 'other';

export const REPORT_REASONS: readonly ReportReason[] = Object.freeze([
  'nudity',
  'malware',
  'profanity',
  'illegal',
  'spam',
  'impersonation',
  'other',
]);

/** How long a "beef" thread runs before the relay purges it. */
export const BEEF_DURATIONS = {
  '24h': 86_400,
  '72h': 259_200,
  '7d': 604_800,
  /** Never expires — no expiration tag is emitted. */
  pinned: null,
} as const;

export type BeefDuration = keyof typeof BEEF_DURATIONS;
