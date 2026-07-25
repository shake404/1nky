import { fingerprint } from '@1nky/protocol';

/**
 * Row -> JSON shaping. Pure, and unit tested.
 *
 * The API speaks the product's language, not the protocol's: a row becomes a
 * flick with a caption and a writer who has a tag and a mark. Nothing here
 * emits the words the copy deck forbids.
 */

/** `bigint` columns arrive from `pg` as strings. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The mark is a fingerprint of the pubkey; junk in the column means none. */
export function markOf(pubkey: string): string | null {
  try {
    return fingerprint(pubkey);
  } catch {
    return null;
  }
}

export interface WriterJson {
  pubkey: string;
  tag: string | null;
  mark: string | null;
  avatarSha256: string | null;
  city?: string | null;
}

export interface WriterSource {
  pubkey: string;
  tag_name?: string | null;
  avatar_sha256?: string | null;
  city?: string | null;
}

export function shapeWriter(row: WriterSource): WriterJson {
  const writer: WriterJson = {
    pubkey: row.pubkey,
    tag: row.tag_name ?? null,
    mark: markOf(row.pubkey),
    avatarSha256: row.avatar_sha256 ?? null,
  };
  if (row.city !== undefined) writer.city = row.city;
  return writer;
}

export interface FlickSource extends WriterSource {
  event_id: string;
  created_at: number | string;
  url: string;
  sha256: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string | null;
  boards: string[] | null;
  reply_count?: number | string;
}

export interface FlickJson {
  id: string;
  createdAt: number;
  url: string;
  sha256: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string;
  boards: string[];
  replyCount: number;
  writer: WriterJson;
}

export function shapeFlick(row: FlickSource): FlickJson {
  return {
    id: row.event_id,
    createdAt: num(row.created_at),
    url: row.url,
    sha256: row.sha256,
    width: nullableNum(row.width),
    height: nullableNum(row.height),
    blurhash: row.blurhash ?? null,
    caption: row.caption ?? '',
    boards: row.boards ?? [],
    replyCount: num(row.reply_count),
    writer: shapeWriter(row),
  };
}

/**
 * A unified feed row — a flick or a video — tagged with `mediaType` so the
 * client picks an `<img>` or a `<video>`. Video rows also carry the poster
 * still URL and duration; flick rows report null for both.
 */
export interface FeedItemSource extends WriterSource {
  event_id: string;
  created_at: number | string;
  url: string;
  sha256: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string | null;
  boards: string[] | null;
  reply_count?: number | string;
  media_type: string;
  poster_url: string | null;
  duration: number | string | null;
}

export interface FeedItemJson {
  id: string;
  mediaType: 'flick' | 'video';
  createdAt: number;
  url: string;
  sha256: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  caption: string;
  boards: string[];
  replyCount: number;
  /** Poster still URL for a video; null for a flick. */
  posterUrl: string | null;
  /** Duration in seconds for a video; null for a flick. */
  duration: number | null;
  writer: WriterJson;
}

export function shapeFeedItem(row: FeedItemSource): FeedItemJson {
  return {
    id: row.event_id,
    mediaType: row.media_type === 'video' ? 'video' : 'flick',
    createdAt: num(row.created_at),
    url: row.url,
    sha256: row.sha256,
    width: nullableNum(row.width),
    height: nullableNum(row.height),
    blurhash: row.blurhash ?? null,
    caption: row.caption ?? '',
    boards: row.boards ?? [],
    replyCount: num(row.reply_count),
    posterUrl: row.poster_url ?? null,
    duration: nullableNum(row.duration),
    writer: shapeWriter(row),
  };
}

// ---------------------------------------------------------------------------
// Threads — a kind-1 OP on a city board, "beef" when it carries an expiry
// ---------------------------------------------------------------------------

export interface ThreadSummarySource extends WriterSource {
  event_id: string;
  subject: string | null;
  excerpt: string | null;
  created_at: number | string;
  expires_at: number | string | null;
  reply_count?: number | string;
  last_reply_at?: number | string | null;
}

export interface ThreadSummaryJson {
  id: string;
  subject: string | null;
  /** The first ~160 characters of the OP, cut in Postgres. */
  excerpt: string;
  writer: WriterJson;
  createdAt: number;
  /**
   * When this thread disappears (unix seconds), or null when it is permanent.
   * The copy deck calls a thread with one a **beef**; the field name is the
   * mechanism, the UI supplies the word.
   */
  expiresAt: number | null;
  replyCount: number;
  /** When the newest reply landed, or null when nobody has replied. */
  lastReplyAt: number | null;
}

export function shapeThreadSummary(row: ThreadSummarySource): ThreadSummaryJson {
  return {
    id: row.event_id,
    subject: row.subject ?? null,
    excerpt: row.excerpt ?? '',
    writer: shapeWriter(row),
    createdAt: num(row.created_at),
    expiresAt: nullableNum(row.expires_at),
    replyCount: num(row.reply_count),
    lastReplyAt: nullableNum(row.last_reply_at),
  };
}

export interface ThreadSource extends WriterSource {
  event_id: string;
  subject: string | null;
  content: string | null;
  boards: string[] | null;
  created_at: number | string;
  expires_at: number | string | null;
  reply_count?: number | string;
}

export interface ThreadJson {
  id: string;
  subject: string | null;
  content: string;
  boards: string[];
  writer: WriterJson;
  createdAt: number;
  expiresAt: number | null;
  replyCount: number;
}

export function shapeThread(row: ThreadSource): ThreadJson {
  return {
    id: row.event_id,
    subject: row.subject ?? null,
    content: row.content ?? '',
    boards: row.boards ?? [],
    writer: shapeWriter(row),
    createdAt: num(row.created_at),
    expiresAt: nullableNum(row.expires_at),
    replyCount: num(row.reply_count),
  };
}

export interface ProfileSource extends WriterSource {
  first_seen?: number | string;
  updated_at?: number | string;
  first_event_at?: number | string | null;
  event_count?: number | string;
  banned?: boolean;
  /** Self-declared crew pubkeys/handles from kind-0 `content.crews`. */
  crews?: string[] | null;
}

export interface ProfileJson extends WriterJson {
  firstSeen: number | null;
  updatedAt: number | null;
  flickCount?: number;
  eventCount: number;
  banned: boolean;
  /** Self-declared crew affiliations — a claim, not a verified roster. */
  crews: string[];
}

export function shapeProfile(row: ProfileSource): ProfileJson {
  return {
    ...shapeWriter(row),
    firstSeen: nullableNum(row.first_event_at ?? row.first_seen),
    updatedAt: nullableNum(row.updated_at),
    eventCount: num(row.event_count),
    banned: row.banned === true,
    crews: row.crews ?? [],
  };
}

// ---------------------------------------------------------------------------
// Comment threading
// ---------------------------------------------------------------------------

export interface CommentSource extends WriterSource {
  event_id: string;
  parent_id: string | null;
  root_id: string | null;
  created_at: number | string;
  content: string | null;
}

export interface CommentJson {
  id: string;
  parentId: string | null;
  createdAt: number;
  content: string;
  writer: WriterJson;
  replies: CommentJson[];
}

/**
 * Flattens a root's comments into a tree.
 *
 * Rules, in order of how often they bite:
 *   - a comment whose parent is the root (or is missing) sits at the top level
 *   - a comment whose parent is not in this result set is promoted to the top
 *     level rather than vanishing — its parent may have been buffed
 *   - a cycle (two comments claiming each other as parent) cannot recurse:
 *     children are attached to already-created nodes only, and any node not
 *     reachable from the root is promoted
 *
 * Input is expected oldest-first; output preserves that order at every depth.
 */
export function threadComments(rows: readonly CommentSource[], rootId: string): CommentJson[] {
  const nodes = new Map<string, CommentJson>();
  for (const row of rows) {
    nodes.set(row.event_id, {
      id: row.event_id,
      parentId: row.parent_id,
      createdAt: num(row.created_at),
      content: row.content ?? '',
      writer: shapeWriter(row),
      replies: [],
    });
  }

  const roots: CommentJson[] = [];
  const attached = new Set<string>();

  for (const row of rows) {
    const node = nodes.get(row.event_id);
    if (!node) continue;

    const parentId = row.parent_id;
    if (parentId === null || parentId === rootId || parentId === row.event_id) {
      roots.push(node);
      attached.add(node.id);
      continue;
    }

    const parent = nodes.get(parentId);
    // Only attach to a parent that is itself already placed in the tree —
    // that is what makes a cycle impossible.
    if (parent && attached.has(parentId)) {
      parent.replies.push(node);
      attached.add(node.id);
      continue;
    }

    roots.push(node);
    attached.add(node.id);
  }

  return roots;
}

/** Total comments in a thread, at any depth. */
export function countComments(comments: readonly CommentJson[]): number {
  let total = 0;
  for (const comment of comments) total += 1 + countComments(comment.replies);
  return total;
}
