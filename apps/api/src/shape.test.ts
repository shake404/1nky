import { fingerprint, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildInviteForest,
  countComments,
  INVITE_TREE_MAX_DEPTH,
  INVITE_TREE_MAX_NODES,
  type InviteNodeSource,
  markOf,
  num,
  shapeFeedItem,
  shapeFlick,
  shapeHappening,
  shapeMention,
  shapeProfile,
  shapeThread,
  shapeThreadSummary,
  shapeWriter,
  threadComments,
} from './shape.js';
import {
  commentRow,
  flickRow,
  happeningRow,
  hex,
  mentionRow,
  threadRow,
  threadSummaryRow,
  videoRow,
} from './testing/fixtures.js';

const AUTHOR = hex('ab');

describe('num', () => {
  it('copes with the strings pg returns for bigint', () => {
    expect(num('1700000000')).toBe(1_700_000_000);
    expect(num(42)).toBe(42);
    expect(num(null)).toBe(0);
    expect(num('nope')).toBe(0);
  });
});

describe('shapeWriter', () => {
  it('always carries the mark beside the tag', () => {
    const writer = shapeWriter({ pubkey: AUTHOR, tag_name: 'SMOG' });
    expect(writer.tag).toBe('SMOG');
    expect(writer.mark).toBe(fingerprint(AUTHOR));
    expect(writer.mark).toHaveLength(6);
  });

  it('survives a pubkey the mark function will not accept', () => {
    expect(markOf('not-a-pubkey')).toBeNull();
    expect(shapeWriter({ pubkey: 'not-a-pubkey' }).mark).toBeNull();
  });

  it('reports a writer with no profile event as an untagged writer', () => {
    expect(shapeWriter({ pubkey: AUTHOR }).tag).toBeNull();
  });
});

describe('shapeFlick', () => {
  it('maps a joined row into the product vocabulary', () => {
    const flick = shapeFlick(flickRow() as never);
    expect(flick).toMatchObject({
      id: hex('11'),
      createdAt: 1_700_000_000,
      caption: 'rooftop',
      boards: ['sf'],
      replyCount: 2,
    });
    expect(flick.writer.tag).toBe('SMOG');
  });

  it('defaults missing optional columns', () => {
    const flick = shapeFlick(
      flickRow({ caption: null, boards: null, width: null, reply_count: undefined }) as never,
    );
    expect(flick.caption).toBe('');
    expect(flick.boards).toEqual([]);
    expect(flick.width).toBeNull();
    expect(flick.replyCount).toBe(0);
  });
});

describe('shapeFeedItem', () => {
  it('tags a flick row with mediaType "flick" and null video fields', () => {
    const item = shapeFeedItem(flickRow() as never);
    expect(item.mediaType).toBe('flick');
    expect(item.posterUrl).toBeNull();
    expect(item.duration).toBeNull();
    expect(item.id).toBe(hex('11'));
  });

  it('tags a video row with mediaType "video" and carries the poster + duration', () => {
    const item = shapeFeedItem(videoRow() as never);
    expect(item.mediaType).toBe('video');
    expect(item.posterUrl).toBe('https://cdn.example/p.webp');
    expect(item.duration).toBe(12);
    expect(item.id).toBe(hex('22'));
    expect(item.width).toBe(1280);
  });
});

describe('shapeProfile', () => {
  it('prefers the first event timestamp over the first profile timestamp', () => {
    const profile = shapeProfile({
      pubkey: AUTHOR,
      tag_name: 'SMOG',
      first_seen: '1700000500',
      first_event_at: '1700000000',
      updated_at: '1700000900',
      event_count: '12',
      banned: false,
    });
    expect(profile.firstSeen).toBe(1_700_000_000);
    expect(profile.updatedAt).toBe(1_700_000_900);
    expect(profile.eventCount).toBe(12);
    expect(profile.banned).toBe(false);
  });
});

describe('shapeThreadSummary', () => {
  it('maps a board row into the product vocabulary', () => {
    const thread = shapeThreadSummary(threadSummaryRow() as never);
    expect(thread).toMatchObject({
      id: hex('55'),
      subject: 'Who buffed the Alameda wall?',
      excerpt: 'gone as of this morning',
      createdAt: 1_700_000_000,
      expiresAt: null,
      replyCount: 3,
      lastReplyAt: 1_700_000_900,
    });
    expect(thread.writer.tag).toBe('SMOG');
    expect(thread.writer.mark).toHaveLength(6);
  });

  it('reports a beef expiry as a number the client can count down from', () => {
    const thread = shapeThreadSummary(threadSummaryRow({ expires_at: '1700086400' }) as never);
    expect(thread.expiresAt).toBe(1_700_086_400);
  });

  it('defaults a subject-less, reply-less thread rather than emitting nulls', () => {
    const thread = shapeThreadSummary(
      threadSummaryRow({
        subject: null,
        excerpt: null,
        reply_count: undefined,
        last_reply_at: null,
      }) as never,
    );
    expect(thread.subject).toBeNull();
    expect(thread.excerpt).toBe('');
    expect(thread.replyCount).toBe(0);
    expect(thread.lastReplyAt).toBeNull();
  });

  it('says nothing about the protocol', () => {
    const json = JSON.stringify(shapeThreadSummary(threadSummaryRow() as never));
    for (const word of ['nsec', 'npub', 'relay', 'kind', 'event_id', 'nostr']) {
      expect(json.toLowerCase()).not.toContain(word);
    }
  });
});

describe('shapeThread', () => {
  it('carries the whole OP, its boards and its expiry', () => {
    const thread = shapeThread(threadRow() as never);
    expect(thread).toMatchObject({
      id: hex('55'),
      subject: 'Who buffed the Alameda wall?',
      content: 'gone as of this morning, whole panel',
      boards: ['sf', 'oakland'],
      createdAt: 1_700_000_000,
      expiresAt: null,
      replyCount: 3,
    });
    expect(thread.writer.tag).toBe('SMOG');
  });

  it('defaults missing optional columns', () => {
    const thread = shapeThread(
      threadRow({ subject: null, content: null, boards: null, reply_count: undefined }) as never,
    );
    expect(thread.subject).toBeNull();
    expect(thread.content).toBe('');
    expect(thread.boards).toEqual([]);
    expect(thread.replyCount).toBe(0);
  });
});

describe('happenings', () => {
  it('reports happeningAt as null on an ordinary thread', () => {
    expect(shapeThreadSummary(threadSummaryRow() as never).happeningAt).toBeNull();
    expect(shapeThread(threadRow() as never).happeningAt).toBeNull();
  });

  it('reports the date on a dated thread, in both shapes', () => {
    expect(
      shapeThreadSummary(threadSummaryRow({ happening_at: '1800000000' }) as never).happeningAt,
    ).toBe(1_800_000_000);
    expect(shapeThread(threadRow({ happening_at: 1_800_000_000 }) as never).happeningAt).toBe(
      1_800_000_000,
    );
  });

  it('tolerates a column that is absent entirely (an older row)', () => {
    const row = threadSummaryRow();
    delete row['happening_at'];
    expect(shapeThreadSummary(row as never).happeningAt).toBeNull();
  });

  it('shapeHappening carries the date, the boards and the thread summary', () => {
    const happening = shapeHappening(happeningRow() as never);
    expect(happening).toMatchObject({
      id: hex('66'),
      subject: 'Yard jam',
      excerpt: 'bring paint, 2pm at the wall',
      happeningAt: 1_800_000_000,
      expiresAt: 1_800_604_800,
      boards: ['oakland', 'happening'],
      replyCount: 1,
      lastReplyAt: null,
    });
    expect(happening.writer.tag).toBe('SMOG');
    expect(happening.writer.mark).toHaveLength(6);
  });

  it('defaults a happening with no boards rather than emitting null', () => {
    expect(shapeHappening(happeningRow({ boards: null }) as never).boards).toEqual([]);
  });

  it('says nothing about the protocol', () => {
    const json = JSON.stringify(shapeHappening(happeningRow() as never));
    for (const word of ['nsec', 'npub', 'relay', 'kind', 'event_id', 'nostr', 'expiration']) {
      expect(json.toLowerCase()).not.toContain(word);
    }
  });
});

describe('threadComments', () => {
  const ROOT = hex('11');

  it('nests replies under their parent, oldest first', () => {
    const rows = [
      commentRow({ event_id: hex('22'), parent_id: ROOT, created_at: 1 }),
      commentRow({ event_id: hex('33'), parent_id: hex('22'), created_at: 2 }),
      commentRow({ event_id: hex('44'), parent_id: hex('33'), created_at: 3 }),
      commentRow({ event_id: hex('55'), parent_id: ROOT, created_at: 4 }),
    ];

    const tree = threadComments(rows as never, ROOT);
    expect(tree.map((c) => c.id)).toEqual([hex('22'), hex('55')]);
    expect(tree[0]?.replies.map((c) => c.id)).toEqual([hex('33')]);
    expect(tree[0]?.replies[0]?.replies.map((c) => c.id)).toEqual([hex('44')]);
    expect(countComments(tree)).toBe(4);
  });

  it('promotes an orphan whose parent was buffed', () => {
    const rows = [commentRow({ event_id: hex('33'), parent_id: hex('99'), created_at: 2 })];
    const tree = threadComments(rows as never, ROOT);
    expect(tree.map((c) => c.id)).toEqual([hex('33')]);
  });

  it('cannot be made to recurse forever by a cycle', () => {
    const rows = [
      commentRow({ event_id: hex('22'), parent_id: hex('33') }),
      commentRow({ event_id: hex('33'), parent_id: hex('22') }),
    ];
    const tree = threadComments(rows as never, ROOT);
    expect(countComments(tree)).toBe(2);
    // 22's parent is not yet placed, so it is promoted; 33 then nests under it.
    expect(tree.map((c) => c.id)).toEqual([hex('22')]);
    expect(tree[0]?.replies.map((c) => c.id)).toEqual([hex('33')]);
  });

  it('treats a self-parented comment as top level', () => {
    const rows = [commentRow({ event_id: hex('22'), parent_id: hex('22') })];
    expect(threadComments(rows as never, ROOT).map((c) => c.id)).toEqual([hex('22')]);
  });

  it('returns nothing for an empty thread', () => {
    expect(threadComments([], ROOT)).toEqual([]);
    expect(countComments([])).toBe(0);
  });
});

describe('shapeMention', () => {
  it('says who named you, what they said and where', () => {
    const json = shapeMention(mentionRow() as never);
    expect(json).toEqual({
      id: hex('33'),
      createdAt: 1_700_000_100,
      content: 'ask @KILO, he was there',
      source: 'reply',
      writer: {
        pubkey: AUTHOR,
        tag: 'SMOG',
        mark: fingerprint(AUTHOR),
        avatarSha256: null,
        city: 'sf',
      },
      where: { id: hex('11'), type: 'flick', subject: null, excerpt: 'rooftop' },
    });
  });

  it('tells a tag apart from a reply, so the client need not know a kind', () => {
    // An amendment (kind 1113) — the author added this writer to their own post
    // afterwards. There is no text to show, so the row says which sort it is.
    const tagged = shapeMention(
      mentionRow({ source_kind: KINDS.AMENDMENT, content: null }) as never,
    );
    expect(tagged.source).toBe('tag');
    expect(tagged.content).toBe('');
    // The door still works: a tag lands you on the post you were tagged into.
    expect(tagged.where).toMatchObject({ id: hex('11'), type: 'flick' });
  });

  it('reads a reply as a reply even when the kind is missing', () => {
    // Rows written before `source_kind` existed, and any future kind: a mention
    // with text is a reply until something says otherwise.
    expect(shapeMention(mentionRow({ source_kind: null }) as never).source).toBe('reply');
    expect(shapeMention(mentionRow({ source_kind: '1111' }) as never).source).toBe('reply');
  });

  it('carries a thread title through as the place name', () => {
    const json = shapeMention(
      mentionRow({ root_type: 'thread', root_subject: 'Alameda wall' }) as never,
    );
    expect(json.where).toMatchObject({ type: 'thread', subject: 'Alameda wall' });
  });

  it('falls back to a nameless post rather than emitting null', () => {
    const json = shapeMention(
      mentionRow({ root_type: null, root_excerpt: null, content: null }) as never,
    );
    expect(json.where.type).toBe('post');
    expect(json.where.excerpt).toBe('');
    expect(json.content).toBe('');
  });

  it('never claims to know whether it has been seen', () => {
    expect(Object.keys(shapeMention(mentionRow() as never))).toEqual([
      'id',
      'createdAt',
      'content',
      'source',
      'writer',
      'where',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The invite forest — "getting put on"
// ---------------------------------------------------------------------------

describe('buildInviteForest', () => {
  const A = hex('1a');
  const B = hex('2b');
  const C = hex('3c');
  const D = hex('4d');

  const root = (pubkey: string, over: Partial<InviteNodeSource> = {}): InviteNodeSource => ({
    pubkey,
    tag_name: 'SMOG',
    event_count: '4',
    report_count: '1',
    banned: false,
    ...over,
  });

  const edge = (
    pubkey: string,
    parent: string,
    invitedAt: number,
    over: Partial<InviteNodeSource> = {},
  ): InviteNodeSource => ({ ...root(pubkey), parent, invited_at: String(invitedAt), ...over });

  it('nests a three-level tree and reports no truncation', () => {
    const forest = buildInviteForest(
      [root(A)],
      [edge(B, A, 100), edge(C, B, 200), edge(D, C, 300)],
    );

    expect(forest.truncated).toBe(false);
    expect(forest.roots).toHaveLength(1);
    const [a] = forest.roots;
    expect(a?.pubkey).toBe(A);
    // A root nobody invited has no invitedAt.
    expect(a?.invitedAt).toBeNull();
    expect(a?.mark).toHaveLength(6);
    expect(a?.tag).toBe('SMOG');
    expect(a?.eventCount).toBe(4);
    expect(a?.reportCount).toBe(1);

    const b = a?.children[0];
    expect(b?.pubkey).toBe(B);
    expect(b?.invitedAt).toBe(100);
    expect(b?.children[0]?.pubkey).toBe(C);
    expect(b?.children[0]?.children[0]?.pubkey).toBe(D);
  });

  it('keeps siblings in the order the query handed them over', () => {
    const forest = buildInviteForest([root(A)], [edge(B, A, 100), edge(C, A, 200)]);
    expect(forest.roots[0]?.children.map((c) => c.pubkey)).toEqual([B, C]);
  });

  it('carries the banned flag per node', () => {
    const forest = buildInviteForest([root(A)], [edge(B, A, 100, { banned: true })]);
    expect(forest.roots[0]?.banned).toBe(false);
    expect(forest.roots[0]?.children[0]?.banned).toBe(true);
  });

  it('handles several roots and an empty forest', () => {
    expect(buildInviteForest([], [])).toEqual({ roots: [], truncated: false });
    const forest = buildInviteForest([root(A), root(B)], [edge(C, B, 100)]);
    expect(forest.roots.map((r) => r.pubkey)).toEqual([A, B]);
    expect(forest.roots[1]?.children[0]?.pubkey).toBe(C);
  });

  it('ignores an edge whose parent is not in the forest', () => {
    const forest = buildInviteForest([root(A)], [edge(B, C, 100)]);
    expect(forest.roots[0]?.children).toEqual([]);
    expect(forest.truncated).toBe(false);
  });

  it('stops at the depth cap and says so', () => {
    // A chain one generation longer than the cap allows.
    const chain: InviteNodeSource[] = [];
    let parent = A;
    for (let i = 0; i < INVITE_TREE_MAX_DEPTH + 3; i += 1) {
      // Seeds e0..ee: distinct from each other and from A/B/C/D above.
      const child = hex(`e${i.toString(16)}`);
      chain.push(edge(child, parent, 100 + i));
      parent = child;
    }

    const forest = buildInviteForest([root(A)], chain);
    expect(forest.truncated).toBe(true);

    let depth = 0;
    let node = forest.roots[0];
    while (node?.children[0]) {
      depth += 1;
      node = node.children[0];
    }
    expect(depth).toBe(INVITE_TREE_MAX_DEPTH);
  });

  it('does not claim truncation for a tree that exactly reaches the cap', () => {
    const forest = buildInviteForest([root(A)], [edge(B, A, 100)], { maxDepth: 1 });
    expect(forest.truncated).toBe(false);
    expect(forest.roots[0]?.children).toHaveLength(1);
  });

  it('stops at the node cap and says so', () => {
    const forest = buildInviteForest([root(A)], [edge(B, A, 100), edge(C, A, 200)], {
      maxNodes: 2,
    });
    expect(forest.truncated).toBe(true);
    expect(forest.roots[0]?.children.map((c) => c.pubkey)).toEqual([B]);
  });

  it('caps roots too, when there are more of them than the budget', () => {
    const forest = buildInviteForest([root(A), root(B), root(C)], [], { maxNodes: 2 });
    expect(forest.truncated).toBe(true);
    expect(forest.roots.map((r) => r.pubkey)).toEqual([A, B]);
  });

  it('spends the budget breadth-first, on the writers nearest the root', () => {
    // A -> B, C; B -> D. With room for three nodes both of A's children come
    // back, not one child and one grandchild.
    const forest = buildInviteForest([root(A)], [edge(B, A, 100), edge(C, A, 200), edge(D, B, 300)], {
      maxNodes: 3,
    });
    expect(forest.roots[0]?.children.map((c) => c.pubkey)).toEqual([B, C]);
    expect(forest.roots[0]?.children[0]?.children).toEqual([]);
    expect(forest.truncated).toBe(true);
  });

  it('cannot be made to recurse forever by a cycle', () => {
    // Legal in the schema: A put B on, then later B put A on, because A had no
    // parent at the time.
    const forest = buildInviteForest([root(A)], [edge(B, A, 100), edge(A, B, 200)]);
    expect(forest.roots[0]?.children.map((c) => c.pubkey)).toEqual([B]);
    expect(forest.roots[0]?.children[0]?.children).toEqual([]);
  });

  it('is deterministic: the same rows always produce the same response', () => {
    const roots = [root(A)];
    const edges = [edge(B, A, 100), edge(C, A, 200), edge(D, B, 300)];
    const first = buildInviteForest(roots, edges, { maxNodes: 3 });
    const second = buildInviteForest(roots.map((r) => ({ ...r })), edges.map((e) => ({ ...e })), {
      maxNodes: 3,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('caps at depth 12 / 2000 nodes by default', () => {
    expect(INVITE_TREE_MAX_DEPTH).toBe(12);
    expect(INVITE_TREE_MAX_NODES).toBe(2000);
  });
});
