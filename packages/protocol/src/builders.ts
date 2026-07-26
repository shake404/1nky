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

// ---------------------------------------------------------------------------
// Happenings — a thread with a date on it
// ---------------------------------------------------------------------------

/**
 * The board slug that marks a thread as a happening.
 *
 * Deliberately a plain, unprefixed `t` tag rather than a new kind or a new
 * dash-namespace: a happening IS a thread, so riding the existing board
 * machinery means every board read, every reply path and the NIP-40 sweep work
 * on it the day it ships. The one thing that makes it a happening is the
 * companion `when` tag. `parseFacets` knows this slug is a system marker and
 * never reports it as a city.
 */
export const HAPPENING_BOARD = 'happening';

/**
 * How long a happening stays up after it starts, before NIP-40 removes it.
 *
 * A week: long enough that "what happened at the jam" is still readable the
 * following weekend, short enough that the board is a list of what is coming
 * rather than an archive of what is gone.
 */
export const HAPPENING_GRACE_SECONDS = 7 * 86_400;

/** `["when", "<unix-seconds>"]` — the moment a happening happens. */
export type WhenTag = ['when', string];

/**
 * The `when` tag. Validated the same way `buildExpiration` validates its
 * timestamp, and for the same reason: a date is the whole point of a happening,
 * so a non-integer or negative one is a programming error, not a shrug.
 */
export function whenTag(unixSeconds: number): WhenTag {
  if (!Number.isInteger(unixSeconds) || unixSeconds <= 0) {
    throw new TypeError('whenTag: expected a positive integer unix timestamp');
  }
  return ['when', String(unixSeconds)];
}

const UNSIGNED_INT = /^\d+$/;

/**
 * When an event says it happens, or null when it says nothing readable.
 *
 * The FIRST *valid* `when` tag wins — malformed ones are stepped over rather
 * than aborting the read, matching `parseFacets`' habit of ignoring junk
 * instead of surfacing it. Never throws: the indexer hands this every kind-1
 * off the firehose.
 */
export function parseWhen(event: { tags: readonly (readonly string[])[] }): number | null {
  for (const tag of event.tags) {
    if (tag[0] !== 'when') continue;
    const raw = (tag[1] ?? '').trim();
    if (!UNSIGNED_INT.test(raw)) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
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
  /**
   * "Getting put on": the invite this tag is redeeming, if any.
   *
   * Emits one `['invite', <inviteId>, <inviterPubkey>]` tag on the kind 0.
   * Additive and optional — a profile without it is exactly the profile
   * `buildProfile` has always produced, which is what keeps every existing
   * caller (and every already-published profile) valid.
   */
  invite?: { inviteId: string; inviterPubkey: string };
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

  const tags: Tag[] = [];
  if (input.invite) {
    tags.push(inviteRedemptionTag(input.invite.inviteId, input.invite.inviterPubkey));
  }

  return template(KINDS.PROFILE, tags, JSON.stringify(content), input);
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
  /**
   * When the thing actually happens (unix seconds) — this makes the thread a
   * **happening**.
   *
   * Three things follow from setting it, all of them additive:
   *   - a `['when', ...]` tag carrying the date
   *   - the `happening` slug joins the thread's board tags (deduped, so passing
   *     it in `boards` as well emits one tag)
   *   - an `expiration` of `happeningAt + 7 days`, UNLESS the caller passed an
   *     explicit `expiration`, which always wins
   */
  happeningAt?: number;
}

/**
 * Kind 1 — a thread OP on a board.
 *
 * Pass `expiration` (see `beefExpiration`) to make it a beef thread, or
 * `happeningAt` to make it a happening (see `HAPPENING_BOARD`).
 */
export function buildThreadOp(input: BuildThreadOpInput): EventTemplate {
  const tags: Tag[] = [];
  if (input.subject) tags.push(['subject', input.subject]);

  if (input.happeningAt === undefined) {
    tags.push(...boardTags(input.boards));
    return template(KINDS.NOTE, tags, input.content, input);
  }

  // Validates before anything else is built, so a bad date never produces a
  // half-formed happening.
  const when = whenTag(input.happeningAt);
  tags.push(...boardTags([...(input.boards ?? []), HAPPENING_BOARD]));
  tags.push(when);

  const options: BuilderOptions =
    input.expiration === undefined
      ? { ...input, expiration: input.happeningAt + HAPPENING_GRACE_SECONDS }
      : input;
  return template(KINDS.NOTE, tags, input.content, options);
}

// ---------------------------------------------------------------------------
// Mentions — a `p` tag somebody meant, told apart from one the reply implies
// ---------------------------------------------------------------------------

/**
 * The NIP-10 marker that makes a `p` tag a deliberate mention.
 *
 * Every comment already carries `p` tags nobody typed: the parent author and
 * (via `P`) the thread root's author, which is how a reply is addressed. If a
 * "you were named" inbox keyed on `p` alone it would be a second copy of the
 * reply feed — every writer in a thread would be "mentioned" by every reply
 * under them.
 *
 * So a mention carries a marker in position 3, exactly where NIP-10 puts
 * `root`/`reply`/`mention` on an `e` tag: `['p', <pubkey>, '', 'mention']`.
 * Reply-target tags stay unmarked (`['p', <pubkey>, <relay>]`), which means the
 * distinction is in the signed event itself and every reader — indexer, client,
 * any future one — agrees without extra state.
 *
 * Forward-only, and that is fine: the marker ships with the read side, and
 * @-mentions themselves are new enough that the only events without a marker
 * are ones from before mentions could be typed at all.
 */
export const MENTION_MARKER = 'mention';

/** `['p', pubkey, '', 'mention']` — one deliberately named writer. */
export function mentionTag(pubkey: string): Tag {
  return ['p', assertHex32(pubkey, 'mentionTag(pubkey)'), '', MENTION_MARKER];
}

/**
 * Is this tag a deliberate mention?
 *
 * The one place the marker convention is spelled out, shared by every reader so
 * the indexer and the client can never drift on what counts. A `p` tag with no
 * marker (or any other marker) is a reply target, not a mention.
 */
export function isMentionTag(tag: readonly string[] | undefined): boolean {
  if (!tag || tag[0] !== 'p') return false;
  if (tag[3] !== MENTION_MARKER) return false;
  // Lowercased before the check rather than required lowercase: our own
  // builders always emit canonical hex, but a mention that reaches us from
  // another signer should still find its way to the writer it names.
  return HEX64.test((tag[1] ?? '').toLowerCase());
}

/**
 * Every writer an event deliberately named, lowercase, in tag order, deduped.
 *
 * Nothing about the event's kind is checked here — only comments carry mentions
 * today, and a caller who wants that rule applies it where it has consequences
 * (the indexer routes by kind already).
 */
export function mentionedPubkeys(event: { tags?: readonly string[][] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags ?? []) {
    if (!isMentionTag(tag)) continue;
    const pubkey = (tag[1] as string).toLowerCase();
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

export interface BuildCommentOptions extends BuilderOptions {
  content: string;
  /**
   * The root of the thread. Defaults to `parent`, which is correct for a
   * top-level comment on a flick or thread OP.
   */
  root?: EventRef;
  /**
   * Writers named in the body (an @-mention). Each becomes one marked
   * `['p', pubkey, '', 'mention']` tag (see {@link MENTION_MARKER}) so the
   * mention is a *real* reference a reader can key on — and can tell apart from
   * the reply-target `p` tags the comment carries anyway.
   *
   * Deduped against the parent/root `p`/`P` tags already emitted and against
   * each other, so a writer already anchored by the reply (the parent author,
   * say) is never double-tagged. Additive and optional: a comment without it
   * is exactly the comment `buildComment` has always produced.
   */
  mentions?: readonly string[];
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

  if (options.mentions?.length) {
    // Everyone already referenced by an `E`/`e`/`P`/`p` tag — a mention that
    // matches one of these adds nothing and must not emit a second `p`. The
    // reply already addresses them; a duplicate would also make the inbox
    // report a "mention" for what is really just a reply.
    const seen = new Set<string>();
    for (const tag of tags) {
      if (tag[0] === 'p' || tag[0] === 'P') seen.add(tag[1] as string);
    }
    for (const mention of options.mentions) {
      const pubkey = assertHex32(mention, 'buildComment(mention)');
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      tags.push(mentionTag(pubkey));
    }
  }

  return template(KINDS.COMMENT, tags, options.content, options);
}

// ---------------------------------------------------------------------------
// Amendments — "Add to this". Kind 1113 (see KINDS.AMENDMENT).
//
// A signed event is immutable and every comment under a flick references that
// flick's id, so there is no way to "edit" a post: buffing and reposting would
// orphan the whole conversation. An amendment is the additive answer — a second
// event, by the SAME author, that names the original and carries the tags that
// were missing (walls, and writers who should have been named).
//
// ADD-ONLY, and deliberately so:
//   * The merge a reader performs is then a set UNION, which is commutative and
//     idempotent. That is what makes the read model converge no matter what
//     order the events arrive in — and a relay hands back stored events newest
//     first, so an amendment routinely arrives BEFORE the thing it amends.
//   * Removal would need somewhere to hold the original's pre-amendment tag set
//     to recompute against, i.e. a second source of truth for something the
//     signed event already says.
//   * A tag that has had consequences cannot honestly be taken back: a mention
//     has already landed in somebody's shout-outs. Add-only says so out loud.
//   * The escape hatch for a genuinely wrong wall is the one that already
//     exists and is already destructive: buff it and put it up again.
// ---------------------------------------------------------------------------

export interface BuildAmendmentInput extends BuilderOptions {
  /** City walls / board slugs to ADD. Normalised through `normalizeBoard`. */
  boards?: readonly string[];
  /**
   * Writers to name, each emitted as a marked `['p', pubkey, '', 'mention']`
   * tag (see {@link MENTION_MARKER}) — the same convention a comment's
   * @-mentions use, so one reader (`isMentionTag`) recognises both.
   */
  mentions?: readonly string[];
}

/**
 * Kind 1113 — add tags to your own earlier post.
 *
 * `e` + `k` point at the original exactly as a comment's do, so the amendment is
 * self-contained: a reader knows which event and which kind it speaks for without
 * a lookup. The original's author rides in the `e` tag's fourth element, which is
 * what lets a reader check "same author" from the amendment alone.
 *
 * The author is never emitted as a mention: an amendment is signed by the
 * original's author, so naming yourself would only file a shout-out from you to
 * you. Throws when there is nothing to add — an amendment that adds no tag is a
 * programming error, not an empty gesture.
 */
export function buildAmendment(
  original: EventRef,
  input: BuildAmendmentInput = {},
): EventTemplate {
  assertHex32(original.id, 'buildAmendment(original.id)');
  assertHex32(original.pubkey, 'buildAmendment(original.pubkey)');
  if (!Number.isInteger(original.kind) || original.kind < 0) {
    throw new TypeError('buildAmendment: original.kind must be a non-negative integer');
  }

  const boards = boardTags(input.boards);

  const mentions: Tag[] = [];
  // Seeded with the author, so a self-mention is dropped rather than tagged.
  const seen = new Set<string>([original.pubkey]);
  for (const mention of input.mentions ?? []) {
    const pubkey = assertHex32(mention, 'buildAmendment(mention)');
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    mentions.push(mentionTag(pubkey));
  }

  if (boards.length === 0 && mentions.length === 0) {
    throw new TypeError('buildAmendment: nothing to add — pass boards and/or mentions');
  }

  const tags: Tag[] = [
    ['e', original.id, original.relay ?? '', original.pubkey],
    ['k', String(original.kind)],
    ...boards,
    ...mentions,
  ];

  return template(KINDS.AMENDMENT, tags, '', input);
}

/** What an amendment says it adds, and to what. */
export interface ParsedAmendment {
  /** The event being amended. */
  targetId: string;
  /** The target's kind from the `k` tag, or null when it says nothing readable. */
  targetKind: number | null;
  /** Normalised board slugs, deduped, in tag order. */
  boards: string[];
  /** Deliberately named writers, lowercase, deduped, in tag order. */
  mentions: string[];
}

/**
 * Read an amendment, or null when the event is not one.
 *
 * Defensive in the same style as `parseModBan` and `parseInvite`: every other
 * kind and every malformed `e` tag falls through as null rather than throwing,
 * because the indexer hands this whatever comes off the firehose. Authorship is
 * NOT checked here — that comparison has consequences, so it lives where the
 * consequences are (the indexer's SQL guard).
 */
export function parseAmendment(event: {
  kind: number;
  tags?: readonly (readonly string[])[];
}): ParsedAmendment | null {
  if (event.kind !== KINDS.AMENDMENT) return null;
  const tags = event.tags ?? [];

  const eTag = tags.find((tag) => tag[0] === 'e');
  const targetId = (eTag?.[1] ?? '').toLowerCase();
  if (!HEX64.test(targetId)) return null;

  const kindRaw = (tags.find((tag) => tag[0] === 'k')?.[1] ?? '').trim();
  const parsedKind = UNSIGNED_INT.test(kindRaw) ? Number.parseInt(kindRaw, 10) : NaN;
  const targetKind = Number.isSafeInteger(parsedKind) ? parsedKind : null;

  const boards: string[] = [];
  const seenBoard = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== 't') continue;
    const slug = normalizeBoard(tag[1] ?? '');
    if (!slug || seenBoard.has(slug)) continue;
    seenBoard.add(slug);
    boards.push(slug);
  }

  return {
    targetId,
    targetKind,
    boards,
    mentions: mentionedPubkeys({ tags: tags as readonly string[][] }),
  };
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

/**
 * Reason prefix that also asks for a subtree ban, for mod tooling that only has
 * a free-text reason field to work with. `reason: "subtree: tag farm"` and
 * `subtree: true` mean the same thing to the indexer.
 */
export const SUBTREE_BAN_REASON_PREFIX = 'subtree:';

export interface BuildModBanOptions extends BuilderOptions {
  /** Why the writer is being banned. Carried into `banned_pubkeys.reason`. */
  reason?: string;
  /**
   * Ban the whole branch: this writer AND everyone they put on, recursively
   * (see `isSubtreeBan`). Ignored for `unban` — lifting a ban never cascades,
   * because the descendants may each have earned their own ban since.
   */
  subtree?: boolean;
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
  const body: { action: 'ban' | 'unban'; reason?: string; subtree?: true } = { action };
  if (options.reason) body.reason = options.reason;
  // Only a ban cascades, so only a ban carries the flag. Emitting it on an
  // unban would promise something the indexer deliberately does not do.
  if (options.subtree === true && action === 'ban') body.subtree = true;
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

/**
 * True when a mod ban asks for the whole invite branch to go with it.
 *
 * Two spellings, both accepted, because the console and a hand-rolled event
 * reach for different ones:
 *   - content `{"action":"ban","subtree":true}` — what `buildModBan` emits
 *   - a reason starting `subtree:` — for tooling with only a reason field
 *
 * Deliberately a separate function rather than a field on `parseModBan`:
 * `parseModBan` answers "who, and banned or unbanned", which is what every
 * existing caller wants; this answers "how far does it reach", which only the
 * indexer's expansion path cares about. An unban is never a subtree action.
 */
export function isSubtreeBan(event: {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}): boolean {
  const parsed = parseModBan(event);
  if (parsed === null || parsed.action !== 'ban') return false;
  if (parsed.reason !== null && parsed.reason.toLowerCase().startsWith(SUBTREE_BAN_REASON_PREFIX)) {
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return false;
  }
  if (typeof body !== 'object' || body === null) return false;
  return (body as Record<string, unknown>)['subtree'] === true;
}

// ---------------------------------------------------------------------------
// Invites — "getting put on" (Phase 3). Kind 30078 with d = "invite:<id>".
//
// An existing writer mints an invite (a signed event only they could have
// produced); whoever they hand the code to redeems it by putting one `invite`
// tag on their own kind-0 profile. That is the whole protocol: two events, no
// server, no account, and a chain of custody anyone can verify from the relay.
// ---------------------------------------------------------------------------

/** Prefix of the `d` tag on a kind-30078 invite. */
export const INVITE_DTAG_PREFIX = 'invite:';

/**
 * An invite id: 16–64 lowercase hex characters.
 *
 * 16 is 64 bits of secret, which is far past guessable and still short enough
 * to write on a wall; 64 is the ceiling so an id can never be confused for
 * something longer, and matches the pubkey width the code format pairs it with.
 */
const INVITE_ID = /^[0-9a-f]{16,64}$/;

function assertInviteId(value: string, what: string): string {
  if (typeof value !== 'string' || !INVITE_ID.test(value)) {
    throw new TypeError(
      `${what}: expected 16-64 lowercase hex characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export interface BuildInviteOptions extends BuilderOptions {
  /**
   * A note the inviter writes for themselves ("gave this to the kid from
   * 3rd"). Published, so the UI must say so — never a place for a real name.
   */
  note?: string;
}

/**
 * Kind 30078 — minting an invite, signed by the INVITER's tag.
 *
 * Parameterized replaceable, keyed `d = "invite:<inviteId>"`, so re-publishing
 * the same id replaces rather than accumulates and the indexer's "first mint
 * wins" rule has something stable to key on. The content carries a version and
 * nothing that identifies anybody: who minted it is the event's own pubkey.
 */
export function buildInvite(inviteId: string, options: BuildInviteOptions = {}): EventTemplate {
  assertInviteId(inviteId, 'buildInvite(inviteId)');
  const tags: Tag[] = [['d', `${INVITE_DTAG_PREFIX}${inviteId}`]];
  const body: { v: 1; note?: string } = { v: 1 };
  if (options.note) body.note = options.note;
  return template(KINDS.APP_DATA, tags, JSON.stringify(body), options);
}

/**
 * The invite id of a kind-30078 invite, or null when the event is not one.
 *
 * Same defensive style as `parseModBan`: every other kind, every other `d`
 * value and every malformed id falls through as null rather than throwing, so
 * the indexer can hand it any event off the firehose.
 *
 * The `d` tag is the whole identity, so the content is only consulted to refuse
 * a *future* version — an unparseable or empty content is still a v1 invite,
 * but `{"v":2}` is something this code has not been taught to read.
 */
export function parseInvite(event: {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}): { inviteId: string } | null {
  if (event.kind !== KINDS.APP_DATA) return null;
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!d || !d.startsWith(INVITE_DTAG_PREFIX)) return null;
  const inviteId = d.slice(INVITE_DTAG_PREFIX.length).toLowerCase();
  if (!INVITE_ID.test(inviteId)) return null;

  let body: unknown;
  try {
    body = JSON.parse(event.content || '{}');
  } catch {
    return { inviteId };
  }
  if (typeof body === 'object' && body !== null) {
    const v = (body as Record<string, unknown>)['v'];
    if (v !== undefined && v !== 1) return null;
  }
  return { inviteId };
}

/** `["invite", "<inviteId>", "<inviterPubkey>"]` — the redemption tag. */
export type InviteTag = ['invite', string, string];

/**
 * The tag a newcomer puts on their own kind-0 to redeem an invite.
 *
 * The inviter's pubkey rides along even though the indexer could look it up,
 * for the same reason a NIP-22 comment repeats its root: it makes the claim
 * self-contained and checkable from the event alone.
 */
export function inviteRedemptionTag(inviteId: string, inviterPubkey: string): InviteTag {
  return [
    'invite',
    assertInviteId(inviteId, 'inviteRedemptionTag(inviteId)'),
    assertHex32(inviterPubkey, 'inviteRedemptionTag(inviterPubkey)'),
  ];
}

/**
 * The invite a kind-0 profile is redeeming, or null when it redeems none.
 *
 * The FIRST `invite` tag wins, matching how the relay policy and `parseModBan`
 * treat repeated tags — a second one cannot launder a different inviter in.
 */
export function parseInviteRedemption(event: {
  kind: number;
  tags: readonly (readonly string[])[];
}): { inviteId: string; inviterPubkey: string } | null {
  if (event.kind !== KINDS.PROFILE) return null;
  const tag = event.tags.find((t) => t[0] === 'invite');
  if (!tag) return null;
  const inviteId = (tag[1] ?? '').toLowerCase();
  const inviterPubkey = (tag[2] ?? '').toLowerCase();
  if (!INVITE_ID.test(inviteId) || !HEX64.test(inviterPubkey)) return null;
  return { inviteId, inviterPubkey };
}

/**
 * The shareable code: `<inviteId>.<inviterPubkey>`.
 *
 * Both halves travel together so redeeming needs no lookup and no relay round
 * trip before the newcomer's first event — they type one string and their
 * profile can name both sides. A dot separates them: safe in a URL path, in a
 * QR code, and read out loud.
 */
export function encodeInviteCode(inviteId: string, inviterPubkey: string): string {
  const id = assertInviteId(inviteId, 'encodeInviteCode(inviteId)');
  const pubkey = assertHex32(inviterPubkey, 'encodeInviteCode(inviterPubkey)');
  return `${id}.${pubkey}`;
}

/** `encodeInviteCode` in reverse. Returns null on anything malformed. */
export function decodeInviteCode(code: string): {
  inviteId: string;
  inviterPubkey: string;
} | null {
  if (typeof code !== 'string') return null;
  const parts = code.trim().toLowerCase().split('.');
  if (parts.length !== 2) return null;
  const inviteId = parts[0] ?? '';
  const inviterPubkey = parts[1] ?? '';
  if (!INVITE_ID.test(inviteId) || !HEX64.test(inviterPubkey)) return null;
  return { inviteId, inviterPubkey };
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
