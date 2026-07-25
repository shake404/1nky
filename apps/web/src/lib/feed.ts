import { fingerprint, KINDS, type SignedEvent } from '@1nky/protocol';
import { API_BASE } from './config.js';
import { isIgnored } from './mute.js';
import { relay } from './relay.js';

/** What kind of media a feed row carries — picks an `<img>` or a `<video>`. */
export type MediaType = 'flick' | 'video';

/** A flick or a video clip, flattened for rendering. */
export interface Flick {
  id: string;
  pubkey: string;
  mark: string;
  createdAt: number;
  url: string;
  sha256: string;
  width: number;
  height: number;
  caption: string;
  alt?: string;
  /** Tag name, when the indexer joined it in or we have it cached. */
  writer?: string;
  contentWarning?: string;
  /** `flick` (kind 20, picture) or `video` (kind 22, NIP-71). */
  mediaType: MediaType;
  /** Poster still URL for a video; undefined for a flick. */
  posterUrl?: string;
  /** Duration in seconds for a video; undefined for a flick. */
  duration?: number;
  /** Board / facet slugs this post is tagged with. */
  boards?: string[];
}

export interface FeedPage {
  flicks: Flick[];
  /** Opaque cursor for the next page; null when the wall ends. */
  cursor: string | null;
  /** True when the API could not be reached and we read the wall directly. */
  degraded: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseImeta(tags: readonly string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;
    for (let i = 1; i < tag.length; i++) {
      const part = tag[i];
      if (!part) continue;
      const space = part.indexOf(' ');
      if (space < 1) continue;
      const key = part.slice(0, space);
      if (!(key in out)) out[key] = part.slice(space + 1);
    }
  }
  return out;
}

function firstTagValue(tags: readonly string[][], name: string): string | undefined {
  for (const tag of tags) if (tag[0] === name && tag[1]) return tag[1];
  return undefined;
}

/** All `t` tags on an event — used to surface board/facet slugs on a feed row. */
function boardValues(tags: readonly string[][]): string[] | undefined {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] === 't' && tag[1]) out.push(tag[1]);
  }
  return out.length ? out : undefined;
}

/**
 * Turn a kind-20 (flick) or kind-22 (video) event into something renderable.
 *
 * A video is told apart by its kind plus an `image <url>` (poster) line on the
 * `imeta` tag (NIP-92 + NIP-71); a flick has neither. Returns null if unusable.
 */
export function flickFromEvent(event: SignedEvent, writer?: string): Flick | null {
  const isFlick = event.kind === KINDS.FLICK;
  const isVideo = event.kind === KINDS.VIDEO;
  if (!isFlick && !isVideo) return null;

  const imeta = parseImeta(event.tags);
  const sha256 = (imeta['x'] ?? firstTagValue(event.tags, 'x') ?? '').toLowerCase();
  const url = imeta['url'] ?? '';
  if (!url || !HEX64.test(sha256)) return null;

  const dim = /^(\d+)x(\d+)$/.exec(imeta['dim'] ?? '');
  const alt = imeta['alt'] ?? firstTagValue(event.tags, 'alt');
  const contentWarning = firstTagValue(event.tags, 'content-warning');
  const boards = boardValues(event.tags);

  if (isVideo) {
    const poster = imeta['image'] ?? firstTagValue(event.tags, 'image');
    const durationRaw = imeta['duration'] ?? firstTagValue(event.tags, 'duration');
    const duration = Number.parseFloat(durationRaw ?? '');
    // A video with no poster or no duration is not playable as a kind-22.
    if (!poster || !Number.isFinite(duration) || duration <= 0) return null;
    return {
      id: event.id,
      pubkey: event.pubkey,
      mark: fingerprint(event.pubkey),
      createdAt: event.created_at,
      url,
      sha256,
      width: Number.parseInt(dim?.[1] ?? '0', 10) || 1280,
      height: Number.parseInt(dim?.[2] ?? '0', 10) || 720,
      caption: event.content ?? '',
      mediaType: 'video',
      posterUrl: poster,
      duration,
      ...(alt ? { alt } : {}),
      ...(writer ? { writer } : {}),
      ...(contentWarning ? { contentWarning } : {}),
      ...(boards ? { boards } : {}),
    };
  }

  return {
    id: event.id,
    pubkey: event.pubkey,
    mark: fingerprint(event.pubkey),
    createdAt: event.created_at,
    url,
    sha256,
    width: Number.parseInt(dim?.[1] ?? '0', 10) || 1200,
    height: Number.parseInt(dim?.[2] ?? '0', 10) || 1600,
    caption: event.content ?? '',
    mediaType: 'flick',
    ...(alt ? { alt } : {}),
    ...(writer ? { writer } : {}),
    ...(contentWarning ? { contentWarning } : {}),
    ...(boards ? { boards } : {}),
  };
}

/**
 * Read one row of whatever shape the indexer settles on.
 *
 * The unified feed item carries a `mediaType`, a nested `writer` object, and
 * (for videos) `posterUrl` / `duration`. We still accept the older flat row
 * shape and a raw event, so neither the relay-direct fallback nor any older
 * cached client breaks.
 */
function flickFromRow(row: unknown): Flick | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;

  // Raw event (kind 20 / 22) coming back from the relay.
  if (Array.isArray(record['tags']) && typeof record['kind'] === 'number') {
    const writer = typeof record['name'] === 'string' ? record['name'] : undefined;
    return flickFromEvent(record as unknown as SignedEvent, writer);
  }

  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const url = typeof record['url'] === 'string' ? record['url'] : '';
  const sha256 = typeof record['sha256'] === 'string' ? record['sha256'].toLowerCase() : '';
  if (!HEX64.test(id) || !url || !HEX64.test(sha256)) return null;

  // The writer's pubkey is nested under `writer.pubkey` in the unified shape,
  // or flat as `pubkey` in the older shape.
  const writerRaw = record['writer'];
  const writerRecord = typeof writerRaw === 'object' && writerRaw !== null ? (writerRaw as Record<string, unknown>) : null;
  const pubkeyRaw =
    typeof writerRecord?.['pubkey'] === 'string'
      ? writerRecord['pubkey']
      : typeof record['pubkey'] === 'string'
        ? record['pubkey']
        : '';
  const pubkey = pubkeyRaw.toLowerCase();
  if (!HEX64.test(pubkey)) return null;

  // The writer's tag name is nested under `writer.tag` in the unified shape,
  // or flat as `name` in the older shape.
  const writerNestedTag = writerRecord?.['tag'];
  const writer = typeof writerNestedTag === 'string' ? writerNestedTag : typeof record['name'] === 'string' ? record['name'] : undefined;
  const alt = typeof record['alt'] === 'string' ? record['alt'] : undefined;

  const mediaType: MediaType = record['mediaType'] === 'video' || record['media_type'] === 'video' ? 'video' : 'flick';

  const posterUrl =
    typeof record['posterUrl'] === 'string' ? record['posterUrl'] : typeof record['poster_url'] === 'string' ? record['poster_url'] : undefined;
  const rawDuration = record['duration'];
  const duration =
    typeof rawDuration === 'number' ? rawDuration : typeof rawDuration === 'string' ? Number.parseFloat(rawDuration) : NaN;

  const boardsRaw = record['boards'];
  const boards = Array.isArray(boardsRaw) ? (boardsRaw as string[]) : undefined;

  const base: Flick = {
    id,
    pubkey,
    mark: fingerprint(pubkey),
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : typeof record['created_at'] === 'number' ? record['created_at'] : 0,
    url,
    sha256,
    width: typeof record['width'] === 'number' ? record['width'] : 1200,
    height: typeof record['height'] === 'number' ? record['height'] : 1600,
    caption: typeof record['caption'] === 'string' ? record['caption'] : '',
    mediaType,
    ...(alt ? { alt } : {}),
    ...(writer ? { writer } : {}),
    ...(boards ? { boards } : {}),
  };

  if (mediaType === 'video' && posterUrl && Number.isFinite(duration) && duration > 0) {
    base.posterUrl = posterUrl;
    base.duration = duration;
  } else if (mediaType === 'video') {
    // A video row missing its poster/duration cannot be rendered as a
    // kind-22 client-side; fall back to treating it as a flick picture so
    // the wall still shows something rather than dropping the post.
    base.mediaType = 'flick';
  }

  return base;
}

/**
 * The one gate ignored writers are dropped at.
 *
 * Every wall in the app — the global feed, Explore (including its degraded
 * client-side filter, which reads through `fetchFeed`), a crew page, a writer's
 * own page — gets its rows shaped here, so filtering here covers all of them
 * without a `.filter()` sprinkled through four routes. `fetchFlick` is
 * deliberately NOT filtered: following a direct link to one post should still
 * show it.
 *
 * Reads the synchronous mirror in `mute.ts`, primed once at launch.
 */
function visible(flicks: readonly Flick[]): Flick[] {
  return flicks.filter((flick) => !isIgnored(flick.pubkey));
}

/** Shape a batch of relay events into a newest-first wall. */
function fromEvents(events: readonly SignedEvent[]): Flick[] {
  return visible(events.map((event) => flickFromEvent(event)).filter((f): f is Flick => f !== null)).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

export function parseFeedResponse(payload: unknown): { flicks: Flick[]; cursor: string | null } {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const rawItems = body['items'] ?? body['flicks'] ?? body['data'] ?? (Array.isArray(payload) ? payload : []);
  const items = Array.isArray(rawItems) ? rawItems : [];
  const flicks = visible(items.map(flickFromRow).filter((f): f is Flick => f !== null));
  const rawCursor = body['cursor'] ?? body['nextCursor'] ?? body['next'];
  return { flicks, cursor: typeof rawCursor === 'string' && rawCursor ? rawCursor : null };
}

const PAGE_SIZE = 24;

/**
 * A page of the global wall.
 *
 * Prefers the read API. If it is not there — early dev, or the box is having
 * a moment — falls back to reading the wall directly so the app still works.
 */
export async function fetchFeed(cursor: string | null, signal?: AbortSignal): Promise<FeedPage> {
  const url = new URL(`${API_BASE}/feed`);
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (cursor) url.searchParams.set('cursor', cursor);

  try {
    const response = await fetch(url, { ...(signal ? { signal } : {}), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('unavailable');
    const parsed = parseFeedResponse(await response.json());
    return { ...parsed, degraded: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return fallbackFeed(cursor);
  }
}

async function fallbackFeed(cursor: string | null): Promise<FeedPage> {
  const until = cursor ? Number.parseInt(cursor, 10) : undefined;
  const events = await relay.query([
    {
      kinds: [KINDS.FLICK, KINDS.VIDEO],
      limit: PAGE_SIZE,
      ...(Number.isFinite(until) ? { until: (until as number) - 1 } : {}),
    },
  ]);
  const flicks = fromEvents(events);
  const last = flicks[flicks.length - 1];
  return {
    flicks,
    // Paginate on what the wall handed back, not on what survived the filter —
    // a page made entirely of ignored writers must not end the wall.
    cursor: events.length === PAGE_SIZE && last ? String(last.createdAt) : null,
    degraded: true,
  };
}

/** Everything one writer has up. */
export async function fetchWriterFlicks(pubkey: string): Promise<Flick[]> {
  try {
    const response = await fetch(`${API_BASE}/writer/${pubkey}/flicks`, {
      headers: { Accept: 'application/json' },
    });
    if (response.ok) return parseFeedResponse(await response.json()).flicks;
  } catch {
    /* fall through to the wall */
  }
  const events = await relay.query([{ kinds: [KINDS.FLICK, KINDS.VIDEO], authors: [pubkey], limit: 60 }]);
  return fromEvents(events);
}

/** One flick by id, for the detail view on a cold load. */
export async function fetchFlick(id: string): Promise<Flick | null> {
  const events = await relay.query([{ ids: [id], limit: 1 }]);
  const first = events[0];
  return first ? flickFromEvent(first) : null;
}