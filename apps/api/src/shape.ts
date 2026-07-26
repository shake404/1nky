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
  happening_at?: number | string | null;
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
  /**
   * When the thing happens, for a **happening** — a thread somebody put a date
   * on. Null for every ordinary thread, which is almost all of them.
   */
  happeningAt: number | null;
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
    happeningAt: nullableNum(row.happening_at ?? null),
    replyCount: num(row.reply_count),
    lastReplyAt: nullableNum(row.last_reply_at),
  };
}

// ---------------------------------------------------------------------------
// Happenings — a thread with a date on it
// ---------------------------------------------------------------------------

export interface HappeningSource extends ThreadSummarySource {
  happening_at: number | string | null;
  boards: string[] | null;
}

export interface HappeningJson extends ThreadSummaryJson {
  /**
   * Never null here: `GET /happenings` selects on `happening_at is not null`, so
   * a row without a date could not have reached this shaper.
   */
  happeningAt: number;
  /** The boards it was posted to, including the `happening` marker itself. */
  boards: string[];
}

export function shapeHappening(row: HappeningSource): HappeningJson {
  return {
    ...shapeThreadSummary(row),
    happeningAt: num(row.happening_at),
    boards: row.boards ?? [],
  };
}

export interface ThreadSource extends WriterSource {
  event_id: string;
  subject: string | null;
  content: string | null;
  boards: string[] | null;
  created_at: number | string;
  expires_at: number | string | null;
  happening_at?: number | string | null;
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
  /** When the thing happens, for a happening; null for an ordinary thread. */
  happeningAt: number | null;
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
    happeningAt: nullableNum(row.happening_at ?? null),
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
  /** True when this writer has an invite edge — see `profileQuery`. */
  put_on?: boolean;
}

export interface ProfileJson extends WriterJson {
  firstSeen: number | null;
  updatedAt: number | null;
  flickCount?: number;
  eventCount: number;
  banned: boolean;
  /** Self-declared crew affiliations — a claim, not a verified roster. */
  crews: string[];
  /**
   * Whether somebody already here put this writer on. A boolean and nothing
   * more: who did it, when, and the rest of the branch are mod-only, because a
   * public invite graph is a public map of who knows whom.
   */
  putOn: boolean;
}

export function shapeProfile(row: ProfileSource): ProfileJson {
  return {
    ...shapeWriter(row),
    firstSeen: nullableNum(row.first_event_at ?? row.first_seen),
    updatedAt: nullableNum(row.updated_at),
    eventCount: num(row.event_count),
    banned: row.banned === true,
    crews: row.crews ?? [],
    putOn: row.put_on === true,
  };
}

// ---------------------------------------------------------------------------
// The invite forest — "getting put on", mod-only
// ---------------------------------------------------------------------------

/**
 * How deep a tree response goes. Twelve generations is far past anything real —
 * the cap exists so one pathological chain cannot turn a mod page into a
 * megabyte of nesting, and so the recursion below is provably finite.
 */
export const INVITE_TREE_MAX_DEPTH = 12;

/** How many nodes a tree response carries, across every level. */
export const INVITE_TREE_MAX_NODES = 2000;

export interface InviteNodeSource {
  pubkey: string;
  parent?: string | null;
  invited_at?: number | string | null;
  tag_name?: string | null;
  event_count?: number | string;
  report_count?: number | string;
  banned?: boolean;
}

export interface InviteNodeJson {
  pubkey: string;
  mark: string | null;
  tag: string | null;
  /** When they were put on, or null for a root nobody invited. */
  invitedAt: number | null;
  banned: boolean;
  eventCount: number;
  reportCount: number;
  children: InviteNodeJson[];
}

export interface InviteForestJson {
  roots: InviteNodeJson[];
  /**
   * True when the response is not the whole forest — the depth or node cap cut
   * it short. Never a silent truncation: a moderator about to ban a branch has
   * to know they are not looking at all of it.
   */
  truncated: boolean;
}

function shapeInviteNode(row: InviteNodeSource): InviteNodeJson {
  return {
    pubkey: row.pubkey,
    mark: markOf(row.pubkey),
    tag: row.tag_name ?? null,
    invitedAt: nullableNum(row.invited_at ?? null),
    banned: row.banned === true,
    eventCount: num(row.event_count),
    reportCount: num(row.report_count),
    children: [],
  };
}

/**
 * Roots + edges -> a forest, capped.
 *
 * Breadth-first by generation, which is what makes truncation useful as well as
 * deterministic: the budget is spent on the writers closest to the root, and a
 * moderator sees the shape of the branch rather than one arbitrary deep spine.
 * Given the same ordered rows the output is byte-identical every time.
 *
 * Three things it refuses to do:
 *   - recurse past `maxDepth`
 *   - emit more than `maxNodes` nodes
 *   - visit a pubkey twice, which is what stops a cycle (A put B on, then B put
 *     A on — legal, because A had no parent at the time) from looping forever
 *
 * Any of the three sets `truncated`.
 */
export function buildInviteForest(
  rootRows: readonly InviteNodeSource[],
  edgeRows: readonly InviteNodeSource[],
  options: { maxDepth?: number; maxNodes?: number } = {},
): InviteForestJson {
  const maxDepth = options.maxDepth ?? INVITE_TREE_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? INVITE_TREE_MAX_NODES;

  const childrenOf = new Map<string, InviteNodeSource[]>();
  for (const row of edgeRows) {
    const parent = row.parent;
    if (typeof parent !== 'string' || parent === '') continue;
    const list = childrenOf.get(parent);
    if (list) list.push(row);
    else childrenOf.set(parent, [row]);
  }

  let truncated = false;
  let count = 0;
  const visited = new Set<string>();

  const roots: InviteNodeJson[] = [];
  let level: { node: InviteNodeJson; depth: number }[] = [];

  for (const row of rootRows) {
    if (visited.has(row.pubkey)) continue;
    if (count >= maxNodes) {
      truncated = true;
      break;
    }
    visited.add(row.pubkey);
    count += 1;
    const node = shapeInviteNode(row);
    roots.push(node);
    level.push({ node, depth: 0 });
  }

  while (level.length > 0) {
    const next: { node: InviteNodeJson; depth: number }[] = [];
    for (const { node, depth } of level) {
      const children = childrenOf.get(node.pubkey);
      if (!children || children.length === 0) continue;
      if (depth >= maxDepth) {
        // There is more tree down there; we are choosing not to walk it.
        truncated = true;
        continue;
      }
      for (const row of children) {
        if (visited.has(row.pubkey)) continue;
        if (count >= maxNodes) {
          truncated = true;
          break;
        }
        visited.add(row.pubkey);
        count += 1;
        const child = shapeInviteNode(row);
        node.children.push(child);
        next.push({ node: child, depth: depth + 1 });
      }
    }
    level = next;
  }

  return { roots, truncated };
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

// ---------------------------------------------------------------------------
// Mentions — "somebody said your name"
// ---------------------------------------------------------------------------

export interface MentionSource extends WriterSource {
  /** The comment that named the reader. */
  event_id: string;
  created_at: number | string;
  content: string | null;
  /** The flick, clip or thread the conversation hangs off. */
  root_id: string;
  root_type: string | null;
  root_subject: string | null;
  root_excerpt: string | null;
}

export interface MentionJson {
  /** The comment that named you. */
  id: string;
  createdAt: number;
  /** What they said. Already truncated by the query. */
  content: string;
  /** Who said it. */
  writer: WriterJson;
  /** Where it was said, and enough to name the place on a list row. */
  where: {
    id: string;
    /** `flick`, `video`, `thread`, or `post` when it fits none of those. */
    type: string;
    /** A thread's title, when it has one. */
    subject: string | null;
    /** A caption or first line, so a row reads as somewhere rather than an id. */
    excerpt: string;
  };
}

/**
 * One row of a writer's mentions.
 *
 * `where` is the whole reason the indexer keeps a root reference: a mention is
 * only useful if the reader can get to the conversation it happened in, and the
 * type is what decides whether that link is a picture or a thread.
 */
export function shapeMention(row: MentionSource): MentionJson {
  return {
    id: row.event_id,
    createdAt: num(row.created_at),
    content: row.content ?? '',
    writer: shapeWriter(row),
    where: {
      id: row.root_id,
      type: row.root_type ?? 'post',
      subject: row.root_subject ?? null,
      excerpt: row.root_excerpt ?? '',
    },
  };
}
