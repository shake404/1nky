import { fingerprint } from '@1nky/protocol';
import { API_BASE } from './config.js';
import { isIgnored } from './mute.js';

/**
 * Boards, threads, and beef.
 *
 * A board is a city (or, less often, something else) that posts get tagged
 * with. A thread is a piece of writing put up ON a board; a **beef** thread is
 * one that was given a lifetime when it went up, and the wall takes it away
 * when that runs out. Nothing here writes — every write is a signed post that
 * goes up through `publish.ts`.
 *
 * Ignored writers are dropped in the parsers below, the same way the wall drops
 * them in `feed.ts`. Doing it at the shaping step means no route has to
 * remember: a thread list, a board's counts, a reply tree all come through
 * here. A thread you followed a direct link to is still shown — same rule the
 * wall uses for a single flick.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** How deep a reply tree is allowed to visually indent before it flattens. */
export const MAX_REPLY_DEPTH = 4;

/** Under this many seconds left, the countdown reads as urgent. */
export const BEEF_URGENT_SECONDS = 6 * 3600;

// --- Shapes ------------------------------------------------------------------

/** One board on the hub. */
export interface BoardSummary {
  slug: string;
  /** Human title; equal to the slug when nobody set one. */
  title: string;
  /** `city` for a city board, or whatever else the wall knows about. */
  kind: string;
  createdAt: number;
  flickCount: number;
  threadCount: number;
  /** Newest thing on it, or null when nothing has landed yet. */
  latestAt: number | null;
}

/** The board a board page is showing. */
export interface BoardMeta {
  slug: string;
  title: string;
  kind: string;
  regionSlug: string | null;
}

/** Who put something up. */
export interface ThreadWriter {
  pubkey: string;
  /** Their tag name, when the wall joined it in. */
  tag: string | null;
  mark: string;
  avatarSha256: string | null;
}

/** A row in a board's thread list. */
export interface ThreadRow {
  id: string;
  subject: string | null;
  excerpt: string;
  writer: ThreadWriter;
  createdAt: number;
  /** When the wall takes it away. Null means it stays up. */
  expiresAt: number | null;
  replyCount: number;
  lastReplyAt: number | null;
}

export interface BoardPage {
  board: BoardMeta | null;
  threads: ThreadRow[];
  cursor: string | null;
}

/** One reply, with its own replies hanging off it. */
export interface ThreadReply {
  id: string;
  parentId: string | null;
  createdAt: number;
  content: string;
  writer: ThreadWriter;
  replies: ThreadReply[];
}

/** The thing at the top of a thread page. */
export interface ThreadOp {
  id: string;
  subject: string | null;
  content: string;
  boards: string[];
  writer: ThreadWriter;
  createdAt: number;
  expiresAt: number | null;
  replyCount: number;
}

export interface ThreadView {
  thread: ThreadOp;
  comments: ThreadReply[];
}

// --- Reading whatever the wall handed back ------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStr(value: unknown): string | null {
  const text = str(value).trim();
  return text ? text : null;
}

function int(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** A timestamp that is allowed to be absent. */
function optionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function writerFrom(value: unknown): ThreadWriter | null {
  const raw = record(value);
  if (!raw) return null;
  const pubkey = str(raw['pubkey']).toLowerCase();
  if (!HEX64.test(pubkey)) return null;
  return {
    pubkey,
    tag: optionalStr(raw['tag']) ?? optionalStr(raw['name']),
    // Trust the wall's mark when it sent one, but never depend on it — the mark
    // is derived from the pubkey and we already hold that.
    mark: optionalStr(raw['mark']) ?? fingerprint(pubkey),
    avatarSha256: optionalStr(raw['avatarSha256']),
  };
}

export function boardFrom(value: unknown): BoardSummary | null {
  const raw = record(value);
  if (!raw) return null;
  const slug = str(raw['slug']).trim().toLowerCase();
  if (!slug) return null;
  return {
    slug,
    title: optionalStr(raw['title']) ?? slug,
    kind: optionalStr(raw['kind']) ?? 'city',
    createdAt: int(raw['createdAt']),
    flickCount: int(raw['flickCount']),
    threadCount: int(raw['threadCount']),
    latestAt: optionalInt(raw['latestAt']),
  };
}

export function parseBoardsResponse(payload: unknown): BoardSummary[] {
  const body = record(payload);
  const rawList = body?.['boards'] ?? (Array.isArray(payload) ? payload : []);
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set<string>();
  const out: BoardSummary[] = [];
  for (const item of list) {
    const board = boardFrom(item);
    if (!board || seen.has(board.slug)) continue;
    seen.add(board.slug);
    out.push(board);
  }
  return out;
}

function threadRowFrom(value: unknown): ThreadRow | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw['id']).toLowerCase();
  if (!HEX64.test(id)) return null;
  const writer = writerFrom(raw['writer']);
  if (!writer) return null;
  return {
    id,
    subject: optionalStr(raw['subject']),
    excerpt: str(raw['excerpt']) || str(raw['content']),
    writer,
    createdAt: int(raw['createdAt']),
    expiresAt: optionalInt(raw['expiresAt']),
    replyCount: int(raw['replyCount']),
    lastReplyAt: optionalInt(raw['lastReplyAt']),
  };
}

function boardMetaFrom(value: unknown): BoardMeta | null {
  const raw = record(value);
  if (!raw) return null;
  const slug = str(raw['slug']).trim().toLowerCase();
  if (!slug) return null;
  return {
    slug,
    title: optionalStr(raw['title']) ?? slug,
    kind: optionalStr(raw['kind']) ?? 'city',
    regionSlug: optionalStr(raw['regionSlug']),
  };
}

export function parseBoardResponse(payload: unknown): BoardPage {
  const body = record(payload) ?? {};
  const rawThreads = body['threads'];
  const list = Array.isArray(rawThreads) ? rawThreads : [];
  const threads = list
    .map(threadRowFrom)
    .filter((t): t is ThreadRow => t !== null && !isIgnored(t.writer.pubkey));
  const cursor = str(body['nextCursor'] ?? body['cursor']);
  return {
    board: boardMetaFrom(body['board']),
    threads,
    cursor: cursor || null,
  };
}

/**
 * Shape one reply and everything under it.
 *
 * Replies from an ignored writer disappear along with their sub-replies —
 * keeping an orphaned branch alive would just be the ignored writer's argument
 * with the branch's other half missing.
 */
function replyFrom(value: unknown): ThreadReply | null {
  const raw = record(value);
  if (!raw) return null;
  const id = str(raw['id']).toLowerCase();
  if (!HEX64.test(id)) return null;
  const writer = writerFrom(raw['writer']);
  if (!writer || isIgnored(writer.pubkey)) return null;
  const rawReplies = raw['replies'];
  const nested = Array.isArray(rawReplies) ? rawReplies : [];
  return {
    id,
    parentId: optionalStr(raw['parentId'])?.toLowerCase() ?? null,
    createdAt: int(raw['createdAt']),
    content: str(raw['content']),
    writer,
    replies: nested
      .map(replyFrom)
      .filter((r): r is ThreadReply => r !== null)
      .sort((a, b) => a.createdAt - b.createdAt),
  };
}

export function parseThreadResponse(payload: unknown): ThreadView | null {
  const body = record(payload) ?? {};
  const raw = record(body['thread']);
  if (!raw) return null;
  const id = str(raw['id']).toLowerCase();
  if (!HEX64.test(id)) return null;
  const writer = writerFrom(raw['writer']);
  if (!writer) return null;

  const rawBoards = raw['boards'];
  const boards = (Array.isArray(rawBoards) ? rawBoards : [])
    .map((b) => str(b).trim().toLowerCase())
    .filter((b) => b.length > 0);

  const rawComments = body['comments'];
  const comments = (Array.isArray(rawComments) ? rawComments : [])
    .map(replyFrom)
    .filter((c): c is ThreadReply => c !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    thread: {
      id,
      subject: optionalStr(raw['subject']),
      content: str(raw['content']),
      boards,
      writer,
      createdAt: int(raw['createdAt']),
      expiresAt: optionalInt(raw['expiresAt']),
      replyCount: int(raw['replyCount']),
    },
    comments,
  };
}

// --- The countdown -----------------------------------------------------------

/** What a beef thread's remaining time reads as on screen. */
export interface BeefClock {
  /** "dies in 23h", "dies in 40m", or "buffed by time" once it is past. */
  text: string;
  /** Under six hours left. Render it hot. */
  urgent: boolean;
  /** Its time already ran out. */
  gone: boolean;
}

/**
 * How long a beef thread has left.
 *
 * Returns null when there is no clock at all — a pinned thread, or an ordinary
 * one that was never given a lifetime. Those get no chip, because "stays up" is
 * the boring default and does not need saying on every row.
 */
export function beefClock(
  expiresAt: number | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): BeefClock | null {
  if (expiresAt === null || expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }

  const left = Math.floor(expiresAt) - now;
  if (left <= 0) return { text: 'buffed by time', urgent: false, gone: true };

  const urgent = left < BEEF_URGENT_SECONDS;
  const minutes = Math.floor(left / 60);
  const hours = Math.floor(left / 3600);
  const days = Math.floor(left / 86_400);

  if (days >= 1) return { text: `dies in ${days}d`, urgent, gone: false };
  if (hours >= 1) return { text: `dies in ${hours}h`, urgent, gone: false };
  // Anything inside the last minute still gets a whole minute — a "0m" chip
  // reads as broken rather than as nearly over.
  return { text: `dies in ${Math.max(1, minutes)}m`, urgent, gone: false };
}

/** What to call a thread with no subject on it: its first line, trimmed. */
export function threadHeadline(thread: Pick<ThreadRow, 'subject' | 'excerpt'>): string {
  if (thread.subject) return thread.subject;
  const firstLine = thread.excerpt.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return 'no words';
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

// --- Requests ----------------------------------------------------------------

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('unavailable');
  return response.json();
}

/**
 * Every board the wall knows about, or just one kind of them.
 *
 * `kind` is passed straight through as `?kind=` — `city` for the city wall.
 * Omit it for everything.
 */
export async function fetchBoards(kind?: string, signal?: AbortSignal): Promise<BoardSummary[]> {
  const url = new URL(`${API_BASE}/boards`);
  if (kind) url.searchParams.set('kind', kind);
  return parseBoardsResponse(await getJson(url.toString(), signal));
}

/** One board's threads, a page at a time. */
export async function fetchBoard(
  slug: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<BoardPage> {
  const url = new URL(`${API_BASE}/board/${encodeURIComponent(slug)}`);
  url.searchParams.set('limit', '30');
  if (cursor) url.searchParams.set('cursor', cursor);
  return parseBoardResponse(await getJson(url.toString(), signal));
}

/** One thread and its replies. Null when there is no such thread. */
export async function fetchThread(id: string, signal?: AbortSignal): Promise<ThreadView | null> {
  return parseThreadResponse(await getJson(`${API_BASE}/thread/${encodeURIComponent(id)}`, signal));
}

/**
 * fetchThread, but patient. A thread that just went up takes the wall a beat
 * to file (relay → index is ~a second), so the compose page's navigation and
 * the post-reply refresh both land here before the row exists. A miss retries
 * briefly before it is called gone; `expectReplies` keeps retrying until the
 * reply count catches up, so a fresh reply does not read as lost.
 */
export async function fetchThreadPatient(
  id: string,
  options: { tries?: number; waitMs?: number; expectReplies?: number; signal?: AbortSignal } = {},
): Promise<ThreadView | null> {
  const tries = Math.max(1, options.tries ?? 4);
  const waitMs = options.waitMs ?? 800;
  const expectReplies = options.expectReplies ?? 0;

  let last: ThreadView | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      last = await fetchThread(id, options.signal);
    } catch (error) {
      if (attempt >= tries - 1) throw error;
      continue;
    }
    if (last !== null && last.thread.replyCount >= expectReplies) return last;
  }
  return last;
}
