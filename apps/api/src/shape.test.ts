import { fingerprint } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import {
  countComments,
  markOf,
  num,
  shapeFeedItem,
  shapeFlick,
  shapeProfile,
  shapeWriter,
  threadComments,
} from './shape.js';
import { commentRow, flickRow, hex, videoRow } from './testing/fixtures.js';

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
