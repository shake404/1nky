import type { GrafType, Surface } from './facets.js';
import { KINDS } from './kinds.js';
import { fingerprint } from './mark.js';
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
  type VideoImeta,
} from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** The `d` tag value on a kind-30078 crew definition (Part 4.1). */
export const CREW_DEFINITION_DTAG = 'crew';
/** The `d` tag value on the site-key-signed crew badge attestation (Part 4.4). */
export const CREW_BADGES_DTAG = 'crew-badges';

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

/**
 * All `t` tags for a flick/video: the existing city `boards` slugs PLUS the
 * dash-namespaced facet slugs (type/surface/region/legal), deduped across the
 * union so passing the same slug two ways emits one tag. Facet vocabularies
 * are typed at compile time and normalised at runtime through the same frozen
 * `normalizeBoard()` the city tags use.
 */
function facetBoardTags(input: {
  boards?: readonly string[];
  types?: readonly GrafType[];
  surfaces?: readonly Surface[];
  region?: string;
  legalPermission?: boolean;
}): BoardTag[] {
  const seen = new Set<string>();
  const out: BoardTag[] = [];
  const push = (slug: string): void => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push(['t', slug]);
  };
  if (input.boards) for (const board of input.boards) push(normalizeBoard(board));
  if (input.types) for (const t of input.types) push(`type-${normalizeBoard(t)}`);
  if (input.surfaces) for (const s of input.surfaces) push(`surface-${normalizeBoard(s)}`);
  if (input.region) push(`region-${normalizeBoard(input.region)}`);
  if (input.legalPermission) push('legal-permission');
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

/**
 * Serialise a video's media description as a NIP-92 `imeta` tag (with the
 * NIP-71 `duration` and NIP-92 `image` poster still fields).
 */
export function videoImetaTag(media: VideoImeta): Tag {
  assertHex32(media.sha256, 'videoImetaTag(sha256)');
  const parts = [`url ${media.url}`, `m ${media.mime ?? 'video/mp4'}`, `x ${media.sha256}`];
  parts.push(`dim ${media.dims.width}x${media.dims.height}`);
  parts.push(`image ${media.poster}`);
  parts.push(`duration ${Math.floor(media.durationSec)}`);
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
  /**
   * Short free-text blurb the writer types about themselves.
   *
   * Serialised as `about` in the kind-0 JSON — that is the field every other
   * Nostr client reads — but it is called `bio` on this side of the API
   * because "about" means nothing to anyone.
   */
  bio?: string;
  /** Blossom address of the avatar blob. */
  avatarSha256?: string;
  /**
   * Self-declared crew affiliations (crew pubkeys, or handles). A *claim*,
   * not a roster: any writer can list any crew, the way they can pick any
   * tag name. It becomes a fact only when cross-referenced against the
   * crew's own signed roster or a mod-issued badge. Serialised as
   * `content.crews`. Additive — omitted when not passed.
   */
  crews?: readonly string[];
}

/** Maximum bio length, in characters. Kept well under the 64KB relay cap. */
export const PROFILE_BIO_MAX = 500;

/** Kind 0 — profile metadata. */
export function buildProfile(input: BuildProfileInput): EventTemplate {
  const tag = input.tag.trim();
  if (!tag) throw new TypeError('buildProfile: tag must not be empty');

  const content: Record<string, unknown> = { name: tag };
  if (input.city) content['city'] = normalizeBoard(input.city);
  if (input.bio !== undefined) {
    const bio = input.bio.trim();
    if (bio.length > PROFILE_BIO_MAX) {
      throw new TypeError(`buildProfile: bio must be at most ${PROFILE_BIO_MAX} characters`);
    }
    // Ecosystem-compatible field name. An empty bio is simply omitted.
    if (bio) content['about'] = bio;
  }
  if (input.avatarSha256) {
    content['avatar_sha256'] = assertHex32(input.avatarSha256, 'buildProfile(avatarSha256)');
  }
  if (input.crews) {
    const crews: string[] = [];
    for (const c of input.crews) {
      const value = c.trim().toLowerCase();
      if (value && !(crews as string[]).includes(value)) crews.push(value);
    }
    if (crews.length > 0) content['crews'] = crews;
  }

  return template(KINDS.PROFILE, [], JSON.stringify(content), input);
}

/**
 * A crew's kind-0 profile. A crew *is* its own keypair, so its profile is
 * structurally identical to a writer's — `buildProfile` does the job. This
 * alias only names the intent at the call site (Part 4.1).
 */
export const buildCrewProfile = buildProfile;

export interface BuildFlickInput extends FlickImeta, BuilderOptions {
  /** Board slugs this flick is posted to — emitted as `t` tags. */
  boards?: readonly string[];
  /** Graffiti-type facets, emitted as `type-*` `t` tags alongside the boards. */
  types?: readonly GrafType[];
  /** Surface facets, emitted as `surface-*` `t` tags. */
  surfaces?: readonly Surface[];
  /** Region facet, emitted as a single `region-*` `t` tag. */
  region?: string;
  /** When true, emits a `legal-permission` `t` tag (the only legal facet). */
  legalPermission?: boolean;
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
  tags.push(...facetBoardTags(input));
  if (input.contentWarning) tags.push(['content-warning', input.contentWarning]);

  return template(KINDS.FLICK, tags, input.caption ?? '', input);
}

export interface BuildVideoInput extends VideoImeta, BuilderOptions {
  /** Board slugs this video is posted to — emitted as `t` tags. */
  boards?: readonly string[];
  /** Graffiti-type facets, emitted as `type-*` `t` tags alongside the boards. */
  types?: readonly GrafType[];
  /** Surface facets, emitted as `surface-*` `t` tags. */
  surfaces?: readonly Surface[];
  /** Region facet, emitted as a single `region-*` `t` tag. */
  region?: string;
  /** When true, emits a `legal-permission` `t` tag (the only legal facet). */
  legalPermission?: boolean;
  /** Caption shown under the video. Becomes the event content. */
  caption?: string;
  /** Optional short title. */
  title?: string;
  /** NIP-36 content warning reason. */
  contentWarning?: string;
}

/**
 * Kind 22 — a short-form video clip (NIP-71), structured exactly like a flick.
 *
 * Emits the NIP-92 `imeta` tag (carrying the NIP-71 `duration` and the poster
 * `image` still) plus top-level `x`, `m` and `duration` tags so relays and
 * indexers can filter on the blob hash and duration without parsing `imeta`.
 */
export function buildVideo(input: BuildVideoInput): EventTemplate {
  assertHex32(input.sha256, 'buildVideo(sha256)');
  if (!input.url) throw new TypeError('buildVideo: url must not be empty');
  if (!input.poster) throw new TypeError('buildVideo: poster must not be empty');
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    throw new TypeError('buildVideo: durationSec must be a positive number');
  }

  const tags: Tag[] = [
    videoImetaTag(input),
    ['x', input.sha256],
    ['m', input.mime ?? 'video/mp4'],
    ['duration', String(Math.floor(input.durationSec))],
  ];
  if (input.title) tags.push(['title', input.title]);
  if (input.alt) tags.push(['alt', input.alt]);
  tags.push(...facetBoardTags(input));
  if (input.contentWarning) tags.push(['content-warning', input.contentWarning]);

  return template(KINDS.VIDEO, tags, input.caption ?? '', input);
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

/** Prefix of the `d` tag on a kind-30078 mod ban/unban action (Phase 2, Part 6). */
export const MOD_BAN_DTAG_PREFIX = 'ban:';

export interface BuildModBanOptions extends BuilderOptions {
  /** Why the writer is being banned. Carried into `banned_pubkeys.reason`. */
  reason?: string;
}

/**
 * Kind 30078 — a moderator ban / unban of a writer.
 *
 * Parameterized replaceable, keyed `d = "ban:<target pubkey>"`, so the latest
 * mod action for a writer always wins and an unban replaces the ban. The
 * indexer applies it to `banned_pubkeys` ONLY when the signer's pubkey is in
 * `SITE_MOD_PUBKEYS`; from anyone else it is inert app data.
 */
export function buildModBan(
  targetPubkey: string,
  action: 'ban' | 'unban',
  options: BuildModBanOptions = {},
): EventTemplate {
  assertHex32(targetPubkey, 'buildModBan(targetPubkey)');
  const tags: Tag[] = [
    ['d', `${MOD_BAN_DTAG_PREFIX}${targetPubkey}`],
    ['p', targetPubkey],
  ];
  const body: { action: 'ban' | 'unban'; reason?: string } = { action };
  if (options.reason) body.reason = options.reason;
  return template(KINDS.APP_DATA, tags, JSON.stringify(body), options);
}

/** The target pubkey + action of a mod ban event, or null when it is not one. */
export function parseModBan(event: {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}): { targetPubkey: string; action: 'ban' | 'unban'; reason: string | null } | null {
  if (event.kind !== KINDS.APP_DATA) return null;
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!d || !d.startsWith(MOD_BAN_DTAG_PREFIX)) return null;
  const targetPubkey = d.slice(MOD_BAN_DTAG_PREFIX.length).toLowerCase();
  if (!HEX64.test(targetPubkey)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (body['action'] !== 'ban' && body['action'] !== 'unban') return null;
  return {
    targetPubkey,
    action: body['action'],
    reason: typeof body['reason'] === 'string' && body['reason'] ? body['reason'] : null,
  };
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

// ---------------------------------------------------------------------------
// Crews — kind 30078 (NIP-78 app data). Two uses of the same registry shape
// the board registry already established: a crew definition (signed by the
// crew's own key) and a crew-badge attestation (signed by the site key).
// ---------------------------------------------------------------------------

export interface BuildCrewDefinitionInput extends BuilderOptions {
  /** The crew's name (its "tag", same word as a writer's). */
  name: string;
  /** The crew's mark (fingerprint). Redundant with the pubkey but cheap. */
  mark?: string;
  /** Member pubkeys — the crew-signed roster, the strong-trust membership list. */
  members: readonly string[];
  /** Optional named links, e.g. `{ instagram: 'https://...' }`. */
  links?: Record<string, string>;
  /** Pubkey of the human founder, when the crew key records it. */
  founderPubkey?: string;
}

/**
 * Kind 30078 — a crew definition, signed by the crew's *own* key.
 *
 * `d: "crew"` is constant (the pubkey already identifies which crew), making
 * this NIP-33 parameterized-replaceable: address `30078:<crew-pubkey>:crew`,
 * so editing crew metadata replaces the same event rather than accumulating
 * history. The roster rides in the content JSON *and* as one `p` tag per
 * member, so either a `#p` tag filter or a content read finds it.
 */
export function buildCrewDefinition(input: BuildCrewDefinitionInput): EventTemplate {
  const name = input.name.trim();
  if (!name) throw new TypeError('buildCrewDefinition: name must not be empty');

  const members: string[] = [];
  const seen = new Set<string>();
  for (const m of input.members) {
    const hex = assertHex32(m, 'buildCrewDefinition(member)');
    if (seen.has(hex)) continue;
    seen.add(hex);
    members.push(hex);
  }

  const tags: Tag[] = [['d', CREW_DEFINITION_DTAG]];
  for (const m of members) tags.push(['p', m]);

  const content: Record<string, unknown> = { name, members };
  if (input.mark) content['mark'] = input.mark;
  if (input.founderPubkey) {
    content['founderPubkey'] = assertHex32(input.founderPubkey, 'buildCrewDefinition(founderPubkey)');
  }
  content['foundedAt'] = input.createdAt ?? nowSeconds();
  if (input.links) content['links'] = input.links;

  return template(KINDS.APP_DATA, tags, JSON.stringify(content), input);
}

export interface BuildCrewBadgeRegistryInput extends BuilderOptions {
  /** Crew pubkeys to attest as verified. */
  crewPubkeys: readonly string[];
}

/**
 * Kind 30078 — the mod-issued crew badge attestation, signed by the SITE key
 * (the same key that signs board registries). `d: "crew-badges"`, content
 * `{"badges":[{pubkey, mark, verifiedAt}]}`. Mirrors the board-registry shape
 * exactly; only the `d` value and signer differ. A badge affects *display*
 * (the ✓), never what the relay accepts — and never anything a crew or its
 * members can self-assert, which is the whole anti-impersonation point.
 */
export function buildCrewBadgeRegistry(input: BuildCrewBadgeRegistryInput): EventTemplate {
  const verifiedAt = input.createdAt ?? nowSeconds();
  const seen = new Set<string>();
  const badges: { pubkey: string; mark: string; verifiedAt: number }[] = [];
  for (const pk of input.crewPubkeys) {
    const hex = assertHex32(pk, 'buildCrewBadgeRegistry(crewPubkey)');
    if (seen.has(hex)) continue;
    seen.add(hex);
    badges.push({ pubkey: hex, mark: fingerprint(hex), verifiedAt });
  }

  const tags: Tag[] = [['d', CREW_BADGES_DTAG]];
  return template(KINDS.APP_DATA, tags, JSON.stringify({ badges }), input);
}
