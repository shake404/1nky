import { parseBoardResponse, type ThreadRow } from './boards.js';
import { API_BASE } from './config.js';
import { parseFeedResponse, type Flick } from './feed.js';

/**
 * One box, everything on the wall.
 *
 * `GET /search?q=` hands back four lists — walls (board slugs), flicks, clips,
 * and talk (threads). Nothing here parses any of them by hand: media goes
 * through `feed.ts` so a clip is told from a picture exactly the way the wall
 * does it, and talk goes through `boards.ts` so a thread row is shaped (and an
 * ignored writer dropped) exactly the way a board does it. Two parsers, not
 * five, and the mute list is enforced in both without this file knowing it
 * exists.
 *
 * Every list is treated as optional. An older box may not answer with clips or
 * talk at all, and the screen has to be fine with that rather than blank.
 */

/** Shortest thing worth asking the wall about. */
export const SEARCH_MIN_LENGTH = 2;

/** How long to wait after the last keystroke before asking. */
export const SEARCH_DEBOUNCE_MS = 260;

/** How much of each list to ask for. */
export const SEARCH_LIMIT = 24;

const HEX64 = /^[0-9a-f]{64}$/;

export interface SearchResults {
  /** What the wall thought we asked for. */
  q: string;
  /** Board slugs, ready to link at `/b/:slug`. */
  boards: string[];
  /** Flicks and clips in one wall, newest first. */
  media: Flick[];
  /** Talk — thread rows, ready to link at `/t/:id`. */
  threads: ThreadRow[];
}

export const NO_RESULTS: SearchResults = Object.freeze({ q: '', boards: [], media: [], threads: [] });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A list that is allowed to be missing entirely. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A wall comes back as a bare slug, or as a row with one on it. */
function slugOf(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  const raw = record(value);
  const slug = raw?.['slug'] ?? raw?.['board'] ?? raw?.['name'];
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

/**
 * Mark a row from the `videos` list as a clip.
 *
 * The wall may or may not repeat `mediaType` on rows it has already sorted into
 * a `videos` array. Stamping it means `feed.ts` applies its own clip rules
 * (poster + duration or it is not playable), rather than us guessing here.
 */
function asClip(row: unknown): unknown {
  const raw = record(row);
  if (!raw) return row;
  if (raw['mediaType'] !== undefined || raw['media_type'] !== undefined) return raw;
  return { ...raw, mediaType: 'video' };
}

/**
 * Give a thread row the nested writer that `boards.ts` expects.
 *
 * Board pages always send `writer: { … }`. Search may be flatter on an older
 * box, so a bare id in `writer` — or a top-level one — is lifted into the same
 * shape rather than dropped on the floor.
 */
function normalizeThread(row: unknown): unknown {
  const raw = record(row);
  if (!raw) return row;
  if (record(raw['writer'])) return raw;

  const flat = raw['writer'] ?? raw['pubkey'] ?? raw['author'];
  if (typeof flat !== 'string' || !HEX64.test(flat.toLowerCase())) return raw;

  const name = raw['tag'] ?? raw['name'];
  return {
    ...raw,
    writer: { pubkey: flat.toLowerCase(), ...(typeof name === 'string' ? { tag: name } : {}) },
  };
}

/**
 * Read whatever the wall answered with. Never throws, never invents a list.
 */
export function parseSearchResponse(payload: unknown): SearchResults {
  const body = record(payload) ?? {};

  const boards: string[] = [];
  for (const item of list(body['boards'])) {
    const slug = slugOf(item);
    if (slug && !boards.includes(slug)) boards.push(slug);
  }

  // One wall, both kinds of media, newest at the top. Ignored writers are
  // already gone by the time this returns — feed.ts drops them while shaping.
  const rows = [...list(body['flicks']), ...list(body['videos']).map(asClip)];
  const seen = new Set<string>();
  const media = parseFeedResponse({ flicks: rows })
    .flicks.filter((flick) => !seen.has(flick.id) && seen.add(flick.id))
    .sort((a, b) => b.createdAt - a.createdAt);

  // Same for talk: boards.ts drops threads from writers you are ignoring.
  const threads = parseBoardResponse({ threads: list(body['threads']).map(normalizeThread) }).threads;

  return {
    q: typeof body['q'] === 'string' ? body['q'] : '',
    boards,
    media,
    threads,
  };
}

/** True when the wall had nothing at all for the query. */
export function isEmpty(results: SearchResults): boolean {
  return results.boards.length === 0 && results.media.length === 0 && results.threads.length === 0;
}

/** `GET /search?q=&limit=`. Exposed so a test can pin the shape of the ask. */
export function searchUrl(q: string, limit: number = SEARCH_LIMIT): string {
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

/**
 * Ask the wall.
 *
 * Throws when the wall cannot be reached — there is no relay-direct degrade for
 * search, because the wall does the matching and a client-side guess over one
 * page of recent posts would quietly answer "nothing" for things that are
 * plainly there. The screen says it could not reach the wall instead.
 */
export async function fetchSearch(
  q: string,
  signal?: AbortSignal,
  limit: number = SEARCH_LIMIT,
): Promise<SearchResults> {
  const response = await fetch(searchUrl(q, limit), {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('unavailable');
  return parseSearchResponse(await response.json());
}
