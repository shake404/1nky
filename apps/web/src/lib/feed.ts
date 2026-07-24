import { fingerprint, KINDS, type SignedEvent } from '@1nky/protocol';
import { API_BASE } from './config.js';
import { relay } from './relay.js';

/** A flick, flattened for rendering. */
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

/** Turn a kind-20 event into something renderable. Returns null if unusable. */
export function flickFromEvent(event: SignedEvent, writer?: string): Flick | null {
  if (event.kind !== KINDS.FLICK) return null;
  const imeta = parseImeta(event.tags);
  const sha256 = (imeta['x'] ?? firstTagValue(event.tags, 'x') ?? '').toLowerCase();
  const url = imeta['url'] ?? '';
  if (!url || !HEX64.test(sha256)) return null;

  const dim = /^(\d+)x(\d+)$/.exec(imeta['dim'] ?? '');
  const alt = imeta['alt'] ?? firstTagValue(event.tags, 'alt');
  const contentWarning = firstTagValue(event.tags, 'content-warning');

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
    ...(alt ? { alt } : {}),
    ...(writer ? { writer } : {}),
    ...(contentWarning ? { contentWarning } : {}),
  };
}

/**
 * Read one row of whatever shape the indexer settles on.
 *
 * The API is not built yet, so this accepts both a raw event and a
 * denormalised row and refuses to care which.
 */
function flickFromRow(row: unknown): Flick | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;

  if (Array.isArray(record['tags']) && typeof record['kind'] === 'number') {
    const writer = typeof record['name'] === 'string' ? record['name'] : undefined;
    return flickFromEvent(record as unknown as SignedEvent, writer);
  }

  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const pubkey = typeof record['pubkey'] === 'string' ? record['pubkey'].toLowerCase() : '';
  const url = typeof record['url'] === 'string' ? record['url'] : '';
  const sha256 = typeof record['sha256'] === 'string' ? record['sha256'].toLowerCase() : '';
  if (!HEX64.test(id) || !HEX64.test(pubkey) || !url || !HEX64.test(sha256)) return null;

  const writer = typeof record['name'] === 'string' ? record['name'] : undefined;
  const alt = typeof record['alt'] === 'string' ? record['alt'] : undefined;

  return {
    id,
    pubkey,
    mark: fingerprint(pubkey),
    createdAt: typeof record['created_at'] === 'number' ? record['created_at'] : 0,
    url,
    sha256,
    width: typeof record['width'] === 'number' ? record['width'] : 1200,
    height: typeof record['height'] === 'number' ? record['height'] : 1600,
    caption: typeof record['caption'] === 'string' ? record['caption'] : '',
    ...(alt ? { alt } : {}),
    ...(writer ? { writer } : {}),
  };
}

export function parseFeedResponse(payload: unknown): { flicks: Flick[]; cursor: string | null } {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const rawItems = body['items'] ?? body['flicks'] ?? body['data'] ?? (Array.isArray(payload) ? payload : []);
  const items = Array.isArray(rawItems) ? rawItems : [];
  const flicks = items.map(flickFromRow).filter((f): f is Flick => f !== null);
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
      kinds: [KINDS.FLICK],
      limit: PAGE_SIZE,
      ...(Number.isFinite(until) ? { until: (until as number) - 1 } : {}),
    },
  ]);
  const flicks = events
    .map((event) => flickFromEvent(event))
    .filter((f): f is Flick => f !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  const last = flicks[flicks.length - 1];
  return {
    flicks,
    cursor: flicks.length === PAGE_SIZE && last ? String(last.createdAt) : null,
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
  const events = await relay.query([{ kinds: [KINDS.FLICK], authors: [pubkey], limit: 60 }]);
  return events
    .map((event) => flickFromEvent(event))
    .filter((f): f is Flick => f !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One flick by id, for the detail view on a cold load. */
export async function fetchFlick(id: string): Promise<Flick | null> {
  const events = await relay.query([{ ids: [id], limit: 1 }]);
  const first = events[0];
  return first ? flickFromEvent(first) : null;
}
