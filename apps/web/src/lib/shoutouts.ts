import { writerFrom, type ThreadWriter } from './boards.js';
import { API_BASE } from './config.js';
import { getPref, setPref } from './db.js';
import { isIgnored } from './mute.js';

/**
 * Shout-outs — the times somebody said your name.
 *
 * Only the times they *meant* to. A reply already reaches the writer it is
 * answering; that is a reply, not a shout-out, and if this list counted those
 * it would be the same conversation twice. So the wall only files a name that
 * was actually typed with an `@` in front of it, and this screen shows what it
 * filed.
 *
 * Nothing here writes anything up. The one piece of state it keeps is the
 * moment this device last looked, which stays on the device: there is no
 * account anywhere to remember it for you, and that is the point, not a
 * shortcoming. Two devices holding the same tag therefore each keep their own
 * "new since", which is the honest answer — they each looked at different times.
 */

/** Where a shout-out happened, and enough to name the place on a row. */
export interface ShoutPlace {
  id: string;
  /** `flick`, `video`, `thread`, or `post` when the wall knows no better. */
  type: string;
  /** A thread's title, when it has one. */
  subject: string | null;
  /** A caption or first line, so a row reads as somewhere. */
  excerpt: string;
}

/**
 * How your name came up.
 *
 * `reply` — somebody typed it in a reply.
 * `tag`   — a writer put it on their own post afterwards (see "Add to this").
 *
 * There is nothing to read for a tag, so a row shows who put you on what rather
 * than pretending to quote them.
 */
export type ShoutSource = 'reply' | 'tag';

/** One shout-out: who said your name, what they said, and where. */
export interface Shout {
  /** The reply, or the addition, that named you. */
  id: string;
  createdAt: number;
  content: string;
  source: ShoutSource;
  writer: ThreadWriter;
  where: ShoutPlace;
}

export interface ShoutsPage {
  shouts: Shout[];
  cursor: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function int(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function placeFrom(value: unknown): ShoutPlace | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw['id']).toLowerCase();
  // No place means no door. A row you cannot open is not worth a row.
  if (!HEX64.test(id)) return null;
  const subject = str(raw['subject']).trim();
  return {
    id,
    type: str(raw['type']).trim().toLowerCase() || 'post',
    subject: subject || null,
    excerpt: str(raw['excerpt']),
  };
}

function shoutFrom(value: unknown): Shout | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw['id']).toLowerCase();
  if (!HEX64.test(id)) return null;
  const writer = writerFrom(raw['writer']);
  if (!writer) return null;
  const where = placeFrom(raw['where']);
  if (!where) return null;
  // Anything the wall does not label is a reply — which is what every row was
  // before there was anything else to be.
  const source: ShoutSource = str(raw['source']) === 'tag' ? 'tag' : 'reply';
  return {
    id,
    createdAt: int(raw['createdAt']),
    content: str(raw['content']),
    source,
    writer,
    where,
  };
}

/**
 * Read whatever the wall handed back.
 *
 * A writer you ignore cannot shout at you — dropping them here means no screen
 * and no counter has to remember, exactly as a board's thread list does it.
 */
export function parseShoutsResponse(payload: unknown): ShoutsPage {
  const body = record(payload) ?? {};
  const rawList = body['mentions'];
  const list = Array.isArray(rawList) ? rawList : [];
  const shouts = list
    .map(shoutFrom)
    .filter((s): s is Shout => s !== null && !isIgnored(s.writer.pubkey));
  const cursor = str(body['nextCursor']);
  return { shouts, cursor: cursor || null };
}

export interface ShoutsRequest {
  cursor?: string | null;
  limit?: number;
}

/** Every time somebody said this writer's name, newest first. */
export async function fetchShouts(
  pubkey: string,
  request: ShoutsRequest = {},
  signal?: AbortSignal,
): Promise<ShoutsPage> {
  const url = new URL(`${API_BASE}/mentions/${encodeURIComponent(pubkey)}`);
  url.searchParams.set('limit', String(request.limit ?? 30));
  if (request.cursor) url.searchParams.set('cursor', request.cursor);

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('unavailable');
  return parseShoutsResponse(await response.json());
}

/** Where a shout-out row goes: the picture it happened under, or the thread. */
export function shoutLink(where: ShoutPlace): string {
  return where.type === 'thread' ? `/t/${where.id}` : `/f/${where.id}`;
}

/** How a row names the place, in the fewest words that still mean something. */
export function placeText(where: ShoutPlace): string {
  const line = (where.subject ?? where.excerpt).split('\n', 1)[0]?.trim() ?? '';
  const trimmed = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  if (trimmed) return trimmed;
  return where.type === 'thread' ? 'a thread' : 'a flick';
}

// --- What this device has already looked at ----------------------------------

const SEEN_KEY = 'shouts-seen';

let seenCache = 0;
let primed = false;
const listeners = new Set<(seenAt: number) => void>();

/**
 * The moment this device last opened the screen.
 *
 * Kept in the same on-device store as every other preference (see db.ts) rather
 * than sent anywhere. Read once, then mirrored, because the badge in the top bar
 * has to be able to answer without waiting on storage.
 */
export async function loadShoutsSeen(): Promise<number> {
  const stored = await getPref<unknown>(SEEN_KEY, 0);
  seenCache = Math.max(0, int(stored));
  primed = true;
  return seenCache;
}

/** The stamp as it stands, without touching storage. */
export function shoutsSeenAt(): number {
  return seenCache;
}

/** True once {@link loadShoutsSeen} has run at least once this session. */
export function shoutsSeenReady(): boolean {
  return primed;
}

/**
 * Remember that everything up to `at` has been looked at.
 *
 * Monotonic: an older stamp never wins, so opening the screen while a page from
 * ten minutes ago is still on it cannot un-see anything newer.
 */
export async function markShoutsSeen(at: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const next = Math.max(seenCache, Math.floor(at));
  if (next === seenCache && primed) return;
  seenCache = next;
  primed = true;
  await setPref(SEEN_KEY, next);
  for (const listener of listeners) listener(next);
}

/** Watch the stamp, so the badge clears the moment the screen is opened. */
export function subscribeShoutsSeen(listener: (seenAt: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the mirror so a fresh fake store can be primed. */
export function resetShoutsSeenCache(): void {
  seenCache = 0;
  primed = false;
  listeners.clear();
}

/** How many of these landed after the last look. */
export function countNew(shouts: readonly Shout[], seenAt: number): number {
  return shouts.filter((shout) => shout.createdAt > seenAt).length;
}

/**
 * The number for the badge: how many unseen shout-outs this writer has.
 *
 * Deliberately a small read — one page, and the badge says "9+" past that
 * rather than paging the whole history to put an exact number on a 9px dot.
 */
export const SHOUT_BADGE_MAX = 9;

export async function unseenShoutCount(pubkey: string, signal?: AbortSignal): Promise<number> {
  const seenAt = primed ? seenCache : await loadShoutsSeen();
  const page = await fetchShouts(pubkey, { limit: SHOUT_BADGE_MAX + 1 }, signal);
  return countNew(page.shouts, seenAt);
}
