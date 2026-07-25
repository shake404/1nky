import {
  KINDS,
  normalizeBoard,
  parseModBan,
  REPORT_REASONS,
  type SignedEvent,
} from '@1nky/protocol';

/**
 * Pure event -> row mappers.
 *
 * Nothing in this file touches the database, the clock or the network, so all
 * of it is unit tested without a live Postgres. A mapper returns `null` when
 * the event is too malformed to store in its derived table — the raw event is
 * still kept in `events` either way, because the relay accepted it and the
 * relay is the source of truth.
 */

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

/** First tag named `name`, or undefined. */
export function findTag(tags: readonly string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

/** Value (element 1) of the first tag named `name`. */
export function tagValue(tags: readonly string[][], name: string): string | undefined {
  const tag = findTag(tags, name);
  const value = tag?.[1];
  return value === undefined || value === '' ? undefined : value;
}

/** Values of every tag named `name`, skipping empties. */
export function tagValues(tags: readonly string[][], name: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    const value = tag[1];
    if (value !== undefined && value !== '') out.push(value);
  }
  return out;
}

/** Deduplicated, normalised board slugs from the event's `t` tags. */
export function boardsOf(event: SignedEvent): string[] {
  const seen = new Set<string>();
  for (const raw of tagValues(event.tags, 't')) {
    const slug = normalizeBoard(raw);
    if (slug) seen.add(slug);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// NIP-40 expiration
// ---------------------------------------------------------------------------

/** Unix seconds from the `expiration` tag, or null when the event is permanent. */
export function expirationOf(event: SignedEvent): number | null {
  const raw = tagValue(event.tags, 'expiration');
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** True when the event's NIP-40 expiry has already passed. */
export function isExpired(event: SignedEvent, nowSeconds: number): boolean {
  const expiresAt = expirationOf(event);
  return expiresAt !== null && expiresAt <= nowSeconds;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string;
  raw: string;
  expires_at: number | null;
}

export function toEventRow(event: SignedEvent): EventRow {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content ?? '',
    tags: JSON.stringify(event.tags ?? []),
    raw: JSON.stringify(event),
    expires_at: expirationOf(event),
  };
}

export interface ProfileRow {
  pubkey: string;
  tag_name: string | null;
  city: string | null;
  /** The writer's bio. Named for the kind-0 JSON field, not for the UI. */
  about: string | null;
  avatar_sha256: string | null;
  /** Self-declared crew pubkeys/handles from kind-0 `content.crews`. A claim. */
  crews: string[];
  first_seen: number;
  updated_at: number;
}

/** Longest bio stored. Matches PROFILE_BIO_MAX in @1nky/protocol. */
const ABOUT_MAX = 500;

/**
 * Kind 0. The content is JSON written by `buildProfile`: `{ name, city,
 * about, avatar_sha256 }`. Unparseable content still produces a row so the
 * writer exists in the index — they just have no tag name yet.
 */
export function toProfileRow(event: SignedEvent): ProfileRow {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(event.content || '{}');
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const str = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  const city = str('city');
  // `about` is the ecosystem-standard field; the relay caps an event at 64KB,
  // so a hostile kind 0 could otherwise park 60KB of prose in every profile
  // row. Truncate to the same limit the builder enforces.
  const about = str('about');
  const crewsRaw = parsed['crews'];
  const crews: string[] = Array.isArray(crewsRaw)
    ? [
        ...new Set(
          crewsRaw
            .filter((c: unknown): c is string => typeof c === 'string' && c.trim() !== '')
            .map((c) => c.trim().toLowerCase()),
        ),
      ]
    : [];
  return {
    pubkey: event.pubkey,
    tag_name: str('name') ?? str('display_name'),
    city: city === null ? null : normalizeBoard(city) || null,
    about: about === null ? null : about.slice(0, ABOUT_MAX),
    avatar_sha256: str('avatar_sha256') ?? str('picture_sha256'),
    crews,
    first_seen: event.created_at,
    updated_at: event.created_at,
  };
}

export interface ImetaFields {
  url: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** NIP-92 `image` — the poster still for a kind-22 video. */
  poster: string | null;
  /** NIP-71 `duration` — whole seconds for a kind-22 video. */
  duration: number | null;
}

const EMPTY_IMETA: ImetaFields = {
  url: null,
  sha256: null,
  width: null,
  height: null,
  blurhash: null,
  poster: null,
  duration: null,
};

/**
 * Parse a NIP-92 `imeta` tag: `['imeta', 'url ...', 'x <sha>', 'dim 1x2', ...]`.
 * Each element after the tag name is `<key> <value>`.
 */
export function parseImeta(tag: readonly string[] | undefined): ImetaFields {
  if (!tag) return { ...EMPTY_IMETA };

  const fields = new Map<string, string>();
  for (const part of tag.slice(1)) {
    const space = part.indexOf(' ');
    if (space <= 0) continue;
    const key = part.slice(0, space);
    const value = part.slice(space + 1).trim();
    if (value !== '' && !fields.has(key)) fields.set(key, value);
  }

  let width: number | null = null;
  let height: number | null = null;
  const dim = fields.get('dim');
  if (dim) {
    const match = /^(\d+)x(\d+)$/.exec(dim);
    if (match) {
      width = Number.parseInt(match[1] as string, 10);
      height = Number.parseInt(match[2] as string, 10);
    }
  }

  const durationRaw = fields.get('duration');
  let duration: number | null = null;
  if (durationRaw) {
    const parsed = Number.parseInt(durationRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
  }

  return {
    url: fields.get('url') ?? null,
    sha256: fields.get('x') ?? null,
    width,
    height,
    blurhash: fields.get('blurhash') ?? null,
    poster: fields.get('image') ?? null,
    duration,
  };
}

export interface FlickRow {
  event_id: string;
  pubkey: string;
  created_at: number;
  url: string;
  sha256: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string;
  boards: string[];
}

/**
 * Kind 20. Requires a url and a blob hash — a flick without an image is not a
 * flick. Falls back to the top-level `x` / `url` tags when `imeta` is missing
 * or partial.
 */
export function toFlickRow(event: SignedEvent): FlickRow | null {
  const imeta = parseImeta(findTag(event.tags, 'imeta'));
  const url = imeta.url ?? tagValue(event.tags, 'url') ?? null;
  const sha256 = imeta.sha256 ?? tagValue(event.tags, 'x') ?? null;
  if (!url || !sha256) return null;

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    url,
    sha256,
    width: imeta.width,
    height: imeta.height,
    blurhash: imeta.blurhash ?? tagValue(event.tags, 'blurhash') ?? null,
    caption: event.content ?? '',
    boards: boardsOf(event),
  };
}

export interface VideoRow {
  event_id: string;
  pubkey: string;
  created_at: number;
  url: string;
  sha256: string;
  poster_url: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string;
  boards: string[];
}

/**
 * Kind 22 (NIP-71 short-form video). Structured exactly like a flick: requires
 * a url and a blob hash, falls back to the top-level `x` / `url` / `duration`
 * tags when `imeta` is missing or partial, and carries the poster still URL.
 */
export function toVideoRow(event: SignedEvent): VideoRow | null {
  const imeta = parseImeta(findTag(event.tags, 'imeta'));
  const url = imeta.url ?? tagValue(event.tags, 'url') ?? null;
  const sha256 = imeta.sha256 ?? tagValue(event.tags, 'x') ?? null;
  if (!url || !sha256) return null;

  const durationTag = tagValue(event.tags, 'duration');
  let duration: number | null = imeta.duration;
  if (duration === null && durationTag !== undefined) {
    const parsed = Number.parseInt(durationTag, 10);
    if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
  }

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    url,
    sha256,
    poster_url: imeta.poster ?? tagValue(event.tags, 'image') ?? null,
    duration,
    width: imeta.width,
    height: imeta.height,
    blurhash: imeta.blurhash ?? tagValue(event.tags, 'blurhash') ?? null,
    caption: event.content ?? '',
    boards: boardsOf(event),
  };
}

export interface ThreadRow {
  event_id: string;
  pubkey: string;
  subject: string | null;
  boards: string[];
  created_at: number;
}

/**
 * Kind 1 — a thread OP on one or more city boards.
 *
 * Never returns null. On this platform a bare kind 1 with neither a subject nor
 * a board tag is still a thread OP (the UI shows its first line as the title
 * and it is reachable by id and by search), so it is indexed with a null
 * subject and an empty board array rather than dropped. `content` and the
 * NIP-40 `expires_at` deliberately stay in `events`, which every thread read
 * joins anyway — one copy, no drift.
 */
export function toThreadRow(event: SignedEvent): ThreadRow {
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    subject: tagValue(event.tags, 'subject') ?? null,
    boards: boardsOf(event),
    created_at: event.created_at,
  };
}

export interface CommentRow {
  event_id: string;
  parent_id: string | null;
  root_id: string | null;
  pubkey: string;
  created_at: number;
  content: string;
}

/**
 * Kind 1111 (NIP-22). Uppercase `E` is the thread root, lowercase `e` the
 * item being replied to. A comment with neither is dropped: it anchors
 * nowhere and would never be rendered.
 */
export function toCommentRow(event: SignedEvent): CommentRow | null {
  const root = tagValue(event.tags, 'E') ?? null;
  const parent = tagValue(event.tags, 'e') ?? null;
  if (root === null && parent === null) return null;

  return {
    event_id: event.id,
    parent_id: parent ?? root,
    root_id: root ?? parent,
    pubkey: event.pubkey,
    created_at: event.created_at,
    content: event.content ?? '',
  };
}

export interface ReportRow {
  event_id: string;
  reporter: string;
  target_pubkey: string | null;
  target_event: string | null;
  reason: string | null;
  note: string;
  created_at: number;
}

function normalizeReason(value: string | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return (REPORT_REASONS as readonly string[]).includes(lower) ? lower : 'other';
}

/**
 * Kind 1984 (NIP-56). The reason rides in element 2 of the `e` tag when an
 * event is reported, or of the `p` tag when a whole writer is.
 */
export function toReportRow(event: SignedEvent): ReportRow | null {
  const eTag = findTag(event.tags, 'e');
  const pTag = findTag(event.tags, 'p');
  const targetEvent = eTag?.[1] ?? null;
  const targetPubkey = pTag?.[1] ?? null;
  if (!targetEvent && !targetPubkey) return null;

  return {
    event_id: event.id,
    reporter: event.pubkey,
    target_pubkey: targetPubkey,
    target_event: targetEvent,
    reason: normalizeReason(eTag?.[2] ?? pTag?.[2]),
    note: event.content ?? '',
    created_at: event.created_at,
  };
}

export interface DeletionRow {
  event_id: string;
  pubkey: string;
  targets: string[];
  created_at: number;
}

/** Kind 5 — a "buff" request naming one or more event ids via `e` tags. */
export function toDeletionRow(event: SignedEvent): DeletionRow | null {
  const targets = [...new Set(tagValues(event.tags, 'e'))];
  if (targets.length === 0) return null;

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    targets,
    created_at: event.created_at,
  };
}

export interface BoardRow {
  slug: string;
  title: string;
  kind: string;
  created_by: string | null;
  created_at: number;
  /** Parent region slug, set only from a registry entry that declares one. */
  region_slug?: string | null;
}

/**
 * Classify a board slug into its facet `kind` by dash-namespace prefix.
 *
 * City tags stay unprefixed (the existing default, preserves every board
 * auto-discovered today). Only the *new* facets get prefixes — see
 * explore-and-crews Part 3.1.
 */
export function boardKindOf(slug: string): string {
  if (slug.startsWith('type-')) return 'type';
  if (slug.startsWith('surface-')) return 'surface';
  if (slug.startsWith('region-')) return 'region';
  if (slug === 'legal-permission') return 'legal';
  return 'city';
}

/**
 * Kind 30078 board registry, signed by the site key. Accepts either
 * `{"boards":[...]}` or a bare array of `{ slug, title, kind }`.
 * Anything else yields no rows. An optional `region` per entry records the
 * parent region slug for a city (Part 3.3).
 */
export function boardRowsFromRegistry(event: SignedEvent): BoardRow[] {
  const d = tagValue(event.tags, 'd');
  if (d !== undefined && !d.startsWith('boards')) return [];

  let list: unknown;
  try {
    list = JSON.parse(event.content || 'null');
  } catch {
    return [];
  }
  if (list !== null && typeof list === 'object' && !Array.isArray(list)) {
    list = (list as Record<string, unknown>)['boards'];
  }
  if (!Array.isArray(list)) return [];

  const rows: BoardRow[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawSlug = typeof record['slug'] === 'string' ? record['slug'] : '';
    const slug = normalizeBoard(rawSlug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const row: BoardRow = {
      slug,
      title: typeof record['title'] === 'string' && record['title'] ? record['title'] : slug,
      kind: typeof record['kind'] === 'string' && record['kind'] ? record['kind'] : 'city',
      created_by: event.pubkey,
      created_at: event.created_at,
    };
    const region = typeof record['region'] === 'string' ? normalizeBoard(record['region']) : null;
    if (region) row.region_slug = region;
    rows.push(row);
  }
  return rows;
}

/** Boards implied by a flick's `t` tags, classified by prefix (Part 3.4). */
export function boardRowsFromFlick(event: SignedEvent): BoardRow[] {
  return boardsOf(event).map((slug) => ({
    slug,
    title: slug,
    kind: boardKindOf(slug),
    created_by: null,
    created_at: event.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Crews — kind 30078 with d:crew (crew-signed) and d:crew-badges (site-signed)
// ---------------------------------------------------------------------------

export interface CrewRow {
  crew_pubkey: string;
  name: string;
  mark: string | null;
  founder_pubkey: string | null;
  founded_at: number | null;
  members: string[];
  created_at: number;
  updated_at: number;
}

/**
 * Kind 30078 with d:crew — a crew definition, signed by the crew's own key.
 * Content JSON: `{ name, members, mark?, founderPubkey?, foundedAt? }`. The
 * roster is read from the `p` tags (wire-canonical, tag-filterable) and
 * merged with `content.members`, deduped. Returns null when the content is
 * unparseable or the crew has no name.
 */
export function crewDefinitionRowFromEvent(event: SignedEvent): CrewRow | null {
  const d = tagValue(event.tags, 'd');
  if (d !== 'crew') return null;

  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(event.content || '{}');
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  const str = (key: string): string | null => {
    const v = parsed[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };

  const name = str('name');
  if (!name) return null;

  const fromContent = Array.isArray(parsed['members'])
    ? (parsed['members'] as unknown[]).filter((m): m is string => typeof m === 'string' && HEX64.test(m))
    : [];
  const fromTags = tagValues(event.tags, 'p').filter((m) => HEX64.test(m));
  const members = [...new Set([...fromTags, ...fromContent])];

  const foundedAtRaw = parsed['foundedAt'];
  const foundedAt =
    typeof foundedAtRaw === 'number' && Number.isFinite(foundedAtRaw) ? foundedAtRaw : event.created_at;

  return {
    crew_pubkey: event.pubkey,
    name,
    mark: str('mark'),
    founder_pubkey: str('founderPubkey'),
    founded_at: foundedAt,
    members,
    created_at: event.created_at,
    updated_at: event.created_at,
  };
}

export interface CrewBadgeRow {
  crew_pubkey: string;
  verified_at: number;
  verified_by: string;
}

/**
 * Kind 30078 with d:crew-badges — site-key-signed attestation. Content:
 * `{"badges":[{pubkey, mark?, verifiedAt?}]}`. Mirrors `boardRowsFromRegistry`
 * exactly; only the `d` value and signer differ (the signer check happens in
 * the store, same as the board registry).
 */
export function crewBadgeRowsFromRegistry(event: SignedEvent): CrewBadgeRow[] {
  const d = tagValue(event.tags, 'd');
  if (d !== 'crew-badges') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content || 'null');
  } catch {
    return [];
  }
  let list: unknown = parsed;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    list = (parsed as Record<string, unknown>)['badges'];
  }
  if (!Array.isArray(list)) return [];

  const rows: CrewBadgeRow[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawPk = typeof record['pubkey'] === 'string' ? record['pubkey'].toLowerCase() : '';
    if (!HEX64.test(rawPk) || seen.has(rawPk)) continue;
    seen.add(rawPk);
    const verifiedAtRaw = record['verifiedAt'];
    const verifiedAt =
      typeof verifiedAtRaw === 'number' && Number.isFinite(verifiedAtRaw) ? verifiedAtRaw : event.created_at;
    rows.push({ crew_pubkey: rawPk, verified_at: verifiedAt, verified_by: event.pubkey });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Moderator bans — kind 30078 with d = "ban:<target pubkey>"
// ---------------------------------------------------------------------------

/** A row of `banned_pubkeys`, the one table a rebuild never truncates. */
export interface BanRow {
  pubkey: string;
  reason: string | null;
  banned_at: number;
  banned_by: string;
}

export interface ModBanAction {
  action: 'ban' | 'unban';
  row: BanRow;
}

/**
 * Kind 30078 with `d = "ban:<target>"` — a moderator ban or unban.
 *
 * Returns null for every other kind-30078 event, so crew definitions, crew
 * badges and the board registry fall through untouched.
 *
 * Authorisation is deliberately NOT checked here. This file is pure mapping;
 * the store is where `event.pubkey` is compared against the configured
 * moderator set, because that is where the decision has consequences.
 * `banned_at` is the event's `created_at` rather than the wall clock, which is
 * what makes the parameterized-replaceable no-regression rule in `queries.ts`
 * work on a replayed or out-of-order firehose.
 */
export function modBanActionFromEvent(event: SignedEvent): ModBanAction | null {
  const parsed = parseModBan(event);
  if (parsed === null) return null;
  return {
    action: parsed.action,
    row: {
      pubkey: parsed.targetPubkey,
      reason: parsed.reason,
      banned_at: event.created_at,
      banned_by: event.pubkey.toLowerCase(),
    },
  };
}

/** Which derived table an event feeds, by kind. */
export function routeOf(
  kind: number,
):
  | 'profile'
  | 'thread'
  | 'flick'
  | 'video'
  | 'comment'
  | 'report'
  | 'deletion'
  | 'registry'
  | 'event' {
  switch (kind) {
    case KINDS.PROFILE:
      return 'profile';
    case KINDS.NOTE:
      return 'thread';
    case KINDS.FLICK:
      return 'flick';
    case KINDS.VIDEO:
      return 'video';
    case KINDS.COMMENT:
      return 'comment';
    case KINDS.REPORT:
      return 'report';
    case KINDS.DELETE:
      return 'deletion';
    case KINDS.APP_DATA:
      return 'registry';
    default:
      return 'event';
  }
}
