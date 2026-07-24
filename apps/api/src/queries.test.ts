import { describe, expect, it } from 'vitest';

import {
  banlistQuery,
  boardsQuery,
  commentsQuery,
  feedQuery,
  flickQuery,
  modQueueQuery,
  profileQuery,
  searchBoardTerms,
  searchQuery,
  writerFlicksQuery,
} from './queries.js';
import { hex } from './testing/fixtures.js';

const ALL = [
  feedQuery({ limit: 24 }),
  flickQuery(hex('11')),
  commentsQuery(hex('11')),
  profileQuery(hex('ab')),
  boardsQuery(),
  writerFlicksQuery({ pubkey: hex('ab'), limit: 24 }),
  searchQuery('burner', 24),
  modQueueQuery(50),
  banlistQuery(),
];

describe('the API is read-only (hard rule #4)', () => {
  it.each(ALL.map((sql, i) => [i, sql] as const))('query %i only selects', (_i, sql) => {
    const text = sql.text.toLowerCase();
    expect(text.trimStart().startsWith('select')).toBe(true);
    for (const verb of ['insert ', 'update ', 'delete ', 'truncate ', 'drop ', 'alter ', 'create ']) {
      expect(text).not.toContain(verb);
    }
  });

  it.each(ALL.map((sql, i) => [i, sql] as const))('query %i binds its values', (_i, sql) => {
    // Every distinct placeholder has exactly one parameter behind it, and
    // there is no parameter without a placeholder.
    const placeholders = new Set(sql.text.match(/\$\d+/g) ?? []);
    expect(placeholders.size).toBe(sql.params.length);
  });
});

describe('feedQuery', () => {
  it('paginates by keyset, not offset', () => {
    const sql = feedQuery({ limit: 24, cursor: { createdAt: 100, eventId: hex('11') } });
    expect(sql.text).toContain('(f.created_at, f.event_id) < ($2::bigint, $3::text)');
    expect(sql.text).toContain('order by f.created_at desc, f.event_id desc');
    expect(sql.text).not.toContain('offset');
    expect(sql.params).toEqual([null, 100, hex('11'), 24]);
  });

  it('makes the board filter and the cursor optional in one statement', () => {
    const sql = feedQuery({ limit: 10, board: 'sf' });
    expect(sql.params).toEqual(['sf', null, null, 10]);
    expect(sql.text).toContain('$1::text is null or $1::text = any(f.boards)');
  });

  it('hides banned writers and buffed flicks', () => {
    const text = feedQuery({ limit: 10 }).text;
    expect(text).toContain('banned_pubkeys');
    expect(text).toContain('deletions d');
  });

  it('includes a reply count', () => {
    expect(feedQuery({ limit: 10 }).text).toContain('reply_count');
  });
});

describe('writerFlicksQuery', () => {
  it('excludes buffed flicks', () => {
    expect(writerFlicksQuery({ pubkey: hex('ab'), limit: 5 }).text).toContain(
      'f.event_id = any(d.targets)',
    );
  });
});

describe('search', () => {
  it('derives board slugs from what the user typed', () => {
    expect(searchBoardTerms('SF Bay')).toEqual(['sf', 'bay', 'sf-bay']);
    expect(searchBoardTerms('#oakland')).toEqual(['oakland']);
    expect(searchBoardTerms('   ')).toEqual([]);
  });

  it('uses websearch_to_tsquery, which never throws on user input', () => {
    const sql = searchQuery('"clean lines" -toy', 25);
    expect(sql.text).toContain("websearch_to_tsquery('english', $1)");
    expect(sql.text).not.toContain('to_tsquery($1)');
    expect(sql.params[0]).toBe('"clean lines" -toy');
    expect(sql.params[2]).toBe(25);
  });

  it('matches board tags as well as captions', () => {
    expect(searchQuery('oakland', 10).text).toContain('f.boards && $2::text[]');
  });
});

describe('modQueueQuery', () => {
  it('joins the reported event, its thumbnail and the reporter stats', () => {
    const text = modQueueQuery(50).text;
    expect(text).toContain('left join events te');
    expect(text).toContain('tf.url      as thumbnail_url');
    expect(text).toContain('left join pubkey_stats rs on rs.pubkey = r.reporter');
    expect(text).toContain('order by r.created_at desc');
  });
});

describe('no query can leak what the schema does not store', () => {
  it.each(ALL.map((sql, i) => [i, sql] as const))('query %i names no client column', (_i, sql) => {
    expect(sql.text).not.toMatch(/(^|_|\.)(ip|inet|addr|user_agent|useragent|session)\b/i);
  });
});
