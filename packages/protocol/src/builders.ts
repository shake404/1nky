import { KINDS } from './kinds.js';
import {
  BEEF_DURATIONS,
  type BeefDuration,
  type BoardTag,
  type EventRef,
  type EventTemplate,
  type ExpirationTag,
  type FlickImeta,
  type ReportReason,
  type Tag,
} from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function assertHex32(value: string, what: string): string {
  if (!HEX64.test(value)) {
    throw new TypeError(`${what}: expected 64-char lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Common options accepted by every builder. */
export interface BuilderOptions {
  /** Override the event timestamp (unix seconds). Defaults to now. */
  createdAt?: number;
  /** NIP-40 expiration (unix seconds). Omit for permanent events. */
  expiration?: number;
}

function template(
  kind: number,
  tags: Tag[],
  content: string,
  options: BuilderOptions = {},
): EventTemplate {
  const all = options.expiration === undefined ? tags : [...tags, buildExpiration(options.expiration)];
  return {
    kind,
    tags: all,
    content,
    created_at: options.createdAt ?? nowSeconds(),
  };
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

/**
 * NIP-40 expiration tag. The relay deletes the event once this passes —
 * this is what makes "beef" threads ephemeral.
 */
export function buildExpiration(unixTs: number): ExpirationTag {
  if (!Number.isInteger(unixTs) || unixTs <= 0) {
    throw new TypeError('buildExpiration: expected a positive integer unix timestamp');
  }
  return ['expiration', String(unixTs)];
}

/** Absolute expiry for a beef duration, or `null` for pinned (never expires). */
export function beefExpiration(duration: BeefDuration, from: number = nowSeconds()): number | null {
  const seconds = BEEF_DURATIONS[duration];
  return seconds === null ? null : from + seconds;
}

/** Lowercase, dash-separated board slug. `"SF Bay"` -> `"sf-bay"`. */
export function normalizeBoard(board: string): string {
  return board
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** `["t", "<slug>"]` */
export function boardTag(board: string): BoardTag {
  return ['t', normalizeBoard(board)];
}

function boardTags(boards: readonly string[] | undefined): BoardTag[] {
  if (!boards?.length) return [];
  const seen = new Set<string>();
  const out: BoardTag[] = [];
  for (const board of boards) {
    const slug = normalizeBoard(board);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(['t', slug]);
  }
  return out;
}

/** Serialise a flick's media description as a NIP-92 `imeta` tag. */
export function imetaTag(media: FlickImeta): Tag {
  assertHex32(media.sha256, 'imetaTag(sha256)');
  const parts = [`url ${media.url}`, `m ${media.mime ?? 'image/webp'}`, `x ${media.sha256}`];
  parts.push(`dim ${media.dims.width}x${media.dims.height}`);
  if (media.blurhash) parts.push(`blurhash ${media.blurhash}`);
  if (media.alt) parts.push(`alt ${media.alt}`);
  if (media.size !== undefined) parts.push(`size ${media.size}`);
  return ['imeta', ...parts];
}

// ---------------------------------------------------------------------------
// Event builders — all return unsigned templates; the caller signs.
// ---------------------------------------------------------------------------

export interface BuildProfileInput extends BuilderOptions {
  /** The writer's tag (never called a "name" in the UI). */
  tag: string;
  /** Home city / board slug. */
  city?: string;
  /** Blossom address of the avatar blob. */
  avatarSha256?: string;
}

/** Kind 0 — profile metadata. */
export function buildProfile(input: BuildProfileInput): EventTemplate {
  const tag = input.tag.trim();
  if (!tag) throw new TypeError('buildProfile: tag must not be empty');

  const content: Record<string, string> = { name: tag };
  if (input.city) content['city'] = normalizeBoard(input.city);
  if (input.avatarSha256) {
    content['avatar_sha256'] = assertHex32(input.avatarSha256, 'buildProfile(avatarSha256)');
  }

  return template(KINDS.PROFILE, [], JSON.stringify(content), input);
}

export interface BuildFlickInput extends FlickImeta, BuilderOptions {
  /** Board slugs this flick is posted to — emitted as `t` tags. */
  boards?: readonly string[];
  /** Caption shown under the image. Becomes the event content. */
  caption?: string;
  /** Optional short title. */
  title?: string;
  /** NIP-36 content warning reason. */
  contentWarning?: string;
}

/**
 * Kind 20 — a flick (picture event, Olas/NIP-68 compatible).
 *
 * Emits the `imeta` tag plus top-level `x` and `m` tags so relays and
 * indexers can filter on the blob hash without parsing `imeta`.
 */
export function buildFlick(input: BuildFlickInput): EventTemplate {
  assertHex32(input.sha256, 'buildFlick(sha256)');
  if (!input.url) throw new TypeError('buildFlick: url must not be empty');

  const tags: Tag[] = [imetaTag(input), ['x', input.sha256], ['m', input.mime ?? 'image/webp']];
  if (input.title) tags.push(['title', input.title]);
  if (input.alt) tags.push(['alt', input.alt]);
  tags.push(...boardTags(input.boards));
  if (input.contentWarning) tags.push(['content-warning', input.contentWarning]);

  return template(KINDS.FLICK, tags, input.caption ?? '', input);
}

export interface BuildThreadOpInput extends BuilderOptions {
  content: string;
  /** Board slugs — emitted as `t` tags. */
  boards?: readonly string[];
  /** Thread title. */
  subject?: string;
}

/**
 * Kind 1 — a thread OP on a board.
 *
 * Pass `expiration` (see `beefExpiration`) to make it a beef thread.
 */
export function buildThreadOp(input: BuildThreadOpInput): EventTemplate {
  const tags: Tag[] = [];
  if (input.subject) tags.push(['subject', input.subject]);
  tags.push(...boardTags(input.boards));
  return template(KINDS.NOTE, tags, input.content, input);
}

export interface BuildCommentOptions extends BuilderOptions {
  content: string;
  /**
   * The root of the thread. Defaults to `parent`, which is correct for a
   * top-level comment on a flick or thread OP.
   */
  root?: EventRef;
}

/**
 * Kind 1111 — a NIP-22 comment.
 *
 * Uppercase `E`/`K`/`P` scope the comment to the thread root; lowercase
 * `e`/`k`/`p` point at the item being replied to. For a top-level comment
 * both sets refer to the same event.
 */
export function buildComment(parent: EventRef, options: BuildCommentOptions): EventTemplate {
  const root = options.root ?? parent;
  assertHex32(root.id, 'buildComment(root.id)');
  assertHex32(root.pubkey, 'buildComment(root.pubkey)');
  assertHex32(parent.id, 'buildComment(parent.id)');
  assertHex32(parent.pubkey, 'buildComment(parent.pubkey)');

  const tags: Tag[] = [
    ['E', root.id, root.relay ?? '', root.pubkey],
    ['K', String(root.kind)],
    ['P', root.pubkey, root.relay ?? ''],
    ['e', parent.id, parent.relay ?? '', parent.pubkey],
    ['k', String(parent.kind)],
    ['p', parent.pubkey, parent.relay ?? ''],
  ];

  return template(KINDS.COMMENT, tags, options.content, options);
}

export interface BuildBuffOptions extends BuilderOptions {
  /** Kinds of the events being buffed — NIP-09 recommends including these. */
  kinds?: readonly number[];
  /** Optional note. Left empty by default; the UI never asks for one. */
  reason?: string;
}

/**
 * Kind 5 — "buff" one or more of your own events (NIP-09 deletion request).
 */
export function buildBuff(eventIds: readonly string[], options: BuildBuffOptions = {}): EventTemplate {
  if (!eventIds.length) throw new TypeError('buildBuff: at least one event id is required');

  const tags: Tag[] = eventIds.map((id) => ['e', assertHex32(id, 'buildBuff(eventId)')]);
  const kinds = new Set(options.kinds ?? []);
  for (const kind of kinds) tags.push(['k', String(kind)]);

  return template(KINDS.DELETE, tags, options.reason ?? '', options);
}

/** What is being flagged: a writer, and optionally one of their events. */
export interface ReportTarget {
  /** Pubkey of the writer being reported. Always required by NIP-56. */
  pubkey: string;
  /** Specific event being reported. Omit to report the writer as a whole. */
  eventId?: string;
  /** Kind of the reported event, when known. */
  kind?: number;
}

export interface BuildReportOptions extends BuilderOptions {
  /** Free-text detail from the reporter. Becomes the event content. */
  note?: string;
}

/** Kind 1984 — "flag it" (NIP-56 report). */
export function buildReport(
  target: ReportTarget,
  reason: ReportReason,
  options: BuildReportOptions = {},
): EventTemplate {
  assertHex32(target.pubkey, 'buildReport(pubkey)');

  const tags: Tag[] = [];
  if (target.eventId) {
    tags.push(['e', assertHex32(target.eventId, 'buildReport(eventId)'), reason]);
    tags.push(['p', target.pubkey]);
    if (target.kind !== undefined) tags.push(['k', String(target.kind)]);
  } else {
    tags.push(['p', target.pubkey, reason]);
  }

  return template(KINDS.REPORT, tags, options.note ?? '', options);
}

export interface BuildMuteListOptions extends BuilderOptions {
  /** Threads / flicks to hide. */
  events?: readonly string[];
  /** Board slugs to hide. */
  boards?: readonly string[];
  /** Words to hide. */
  words?: readonly string[];
}

/**
 * Kind 10000 — "ignore this writer" (NIP-51 mute list).
 *
 * Replaceable: this is the writer's whole mute list, not a delta.
 */
export function buildMuteList(
  pubkeys: readonly string[],
  options: BuildMuteListOptions = {},
): EventTemplate {
  const tags: Tag[] = [];
  for (const pubkey of new Set(pubkeys)) {
    tags.push(['p', assertHex32(pubkey, 'buildMuteList(pubkey)')]);
  }
  for (const id of new Set(options.events ?? [])) {
    tags.push(['e', assertHex32(id, 'buildMuteList(eventId)')]);
  }
  tags.push(...boardTags(options.boards));
  for (const word of new Set(options.words ?? [])) {
    tags.push(['word', word.toLowerCase()]);
  }
  return template(KINDS.MUTE_LIST, tags, '', options);
}
