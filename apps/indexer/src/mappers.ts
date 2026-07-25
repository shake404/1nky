import { KINDS, normalizeBoard, REPORT_REASONS, type SignedEvent } from '@1nky/protocol';

/**
 * Pure event -> row mappers.
 *
 * Nothing in this file touches the database, the clock or the network, so all
 * of it is unit tested without a live Postgres. A mapper returns `null` when
 * the event is too malformed to store in its derived table — the raw event is
 * still kept in `events` either way, because the relay accepted it and the
 * relay is the source of truth.
 */

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
  return {
    pubkey: event.pubkey,
    tag_name: str('name') ?? str('display_name'),
    city: city === null ? null : normalizeBoard(city) || null,
    about: about === null ? null : about.slice(0, ABOUT_MAX),
    avatar_sha256: str('avatar_sha256') ?? str('picture_sha256'),
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
}

const EMPTY_IMETA: ImetaFields = {
  url: null,
  sha256: null,
  width: null,
  height: null,
  blurhash: null,
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

  return {
    url: fields.get('url') ?? null,
    sha256: fields.get('x') ?? null,
    width,
    height,
    blurhash: fields.get('blurhash') ?? null,
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
}

/**
 * Kind 30078 board registry, signed by the site key. Accepts either
 * `{"boards":[...]}` or a bare array of `{ slug, title, kind }`.
 * Anything else yields no rows.
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
    rows.push({
      slug,
      title: typeof record['title'] === 'string' && record['title'] ? record['title'] : slug,
      kind: typeof record['kind'] === 'string' && record['kind'] ? record['kind'] : 'city',
      created_by: event.pubkey,
      created_at: event.created_at,
    });
  }
  return rows;
}

/** Boards implied by a flick's `t` tags, so `/boards` is never empty. */
export function boardRowsFromFlick(event: SignedEvent): BoardRow[] {
  return boardsOf(event).map((slug) => ({
    slug,
    title: slug,
    kind: 'city',
    created_by: null,
    created_at: event.created_at,
  }));
}

/** Which derived table an event feeds, by kind. */
export function routeOf(kind: number): 'profile' | 'flick' | 'comment' | 'report' | 'deletion' | 'registry' | 'event' {
  switch (kind) {
    case KINDS.PROFILE:
      return 'profile';
    case KINDS.FLICK:
      return 'flick';
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
