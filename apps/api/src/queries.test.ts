import { describe, expect, it } from 'vitest';

import {
  banlistQuery,
  boardsQuery,
  commentsQuery,
  crewHeaderQuery,
  crewMediaQuery,
  crewMembersQuery,
  crewReppingQuery,
  exploreFacetsQuery,
  exploreQuery,
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
  boardsQuery('city'),
  writerFlicksQuery({ pubkey: hex('ab'), limit: 24 }),
  searchQuery('burner', 24),
  modQueueQuery(50),
  banlistQuery(),
  exploreQuery({ limit: 24 }),
  exploreQuery({ city: ['sf-bay'], type: ['throwie'], surface: ['street'], region: ['bay-area'], legal: true, limit: 24 }),
  exploreFacetsQuery(),
  crewHeaderQuery(hex('ab')),
  crewMediaQuery({ pubkey: hex('ab'), limit: 24 }),
  crewReppingQuery(hex('ab')),
  crewMembersQuery([hex('ab')]),
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
    expect(sql.text).toContain('(m.created_at, m.event_id) < ($2::bigint, $3::text)');
    expect(sql.text).toContain('order by m.created_at desc, m.event_id desc');
    expect(sql.text).not.toContain('offset');
    expect(sql.params).toEqual([null, 100, hex('11'), 24]);
  });

  it('makes the board filter and the cursor optional in one statement', () => {
    const sql = feedQuery({ limit: 10, board: 'sf' });
    expect(sql.params).toEqual(['sf', null, null, 10]);
    expect(sql.text).toContain('$1::text is null or $1::text = any(m.boards)');
  });

  it('hides banned writers and buffed flicks', () => {
    const text = feedQuery({ limit: 10 }).text;
    expect(text).toContain('banned_pubkeys');
    expect(text).toContain('deletions d');
  });

  it('includes a reply count', () => {
    expect(feedQuery({ limit: 10 }).text).toContain('reply_count');
  });

  it('unions flicks and videos, tagging each row with a media_type', () => {
    const text = feedQuery({ limit: 10 }).text;
    expect(text).toContain('union all');
    expect(text).toContain("from flicks f");
    expect(text).toContain('from videos v');
    expect(text).toContain("'flick'::text as media_type");
    expect(text).toContain("'video'::text as media_type");
    expect(text).toContain('v.poster_url');
    expect(text).toContain('v.duration');
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

describe('exploreQuery', () => {
  it('paginates by keyset, not offset', () => {
    const sql = exploreQuery({
      limit: 24,
      cursor: { createdAt: 100, eventId: hex('11') },
    });
    expect(sql.text).toContain('(m.created_at, m.event_id) < ($6::bigint, $7::text)');
    expect(sql.text).toContain('order by m.created_at desc, m.event_id desc');
    expect(sql.text).not.toContain('offset');
    // [cities, types, surfaces, regions, legal, createdAt, eventId, limit]
    expect(sql.params[5]).toBe(100);
    expect(sql.params[6]).toBe(hex('11'));
    expect(sql.params[7]).toBe(24);
  });

  it('adds the facet prefixes server-side and binds one group per facet', () => {
    const sql = exploreQuery({
      city: ['SF Bay', 'sf-bay'],
      type: ['throwie', 'piece'],
      surface: ['street'],
      region: ['Bay Area'],
      legal: true,
      limit: 10,
    });
    // City normalised + deduped by the builder.
    expect(sql.params[0]).toEqual(['sf-bay']);
    expect(sql.params[1]).toEqual(['type-throwie', 'type-piece']);
    expect(sql.params[2]).toEqual(['surface-street']);
    expect(sql.params[3]).toEqual(['region-bay-area']);
    expect(sql.params[4]).toEqual(['legal-permission']);
    // AND across facets, OR within (array overlap `&&`).
    expect(sql.text).toContain('m.boards && $1::text[]');
    expect(sql.text).toContain('m.boards && $2::text[]');
    expect(sql.text).toContain('m.boards && $5::text[]');
  });

  it('passes null for every empty facet group so the filter is a no-op', () => {
    const sql = exploreQuery({ limit: 10 });
    expect(sql.params.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(sql.text).toContain('$1::text[] is null or m.boards && $1::text[]');
  });

  it('unions flicks and videos with a media_type', () => {
    const text = exploreQuery({ limit: 10 }).text;
    expect(text).toContain('union all');
    expect(text).toContain("'flick'::text as media_type");
    expect(text).toContain("'video'::text as media_type");
  });

  it('omits the legal filter when legal is not requested', () => {
    const sql = exploreQuery({ limit: 10 });
    expect(sql.params[4]).toBeNull();
  });
});

describe('exploreFacetsQuery', () => {
  it('unnests the unified boards arrays and counts per slug', () => {
    const sql = exploreFacetsQuery();
    expect(sql.params).toEqual([]);
    expect(sql.text).toContain('unnest(m.boards)');
    expect(sql.text).toContain('group by tag.slug');
    expect(sql.text.toLowerCase()).toContain('from flicks f');
    expect(sql.text.toLowerCase()).toContain('from videos v');
  });
});

describe('crew queries', () => {
  it('crewHeaderQuery always returns one row, anchored on the pubkey', () => {
    const sql = crewHeaderQuery(hex('ab'));
    expect(sql.text).toContain('from (select $1::text as pk) x');
    expect(sql.text).toContain('left join profiles p');
    expect(sql.text).toContain('left join crews c');
    expect(sql.text).toContain('left join crew_badges cb');
    expect(sql.params).toEqual([hex('ab')]);
  });

  it('crewMediaQuery filters the union to one pubkey and keyset-paginates', () => {
    const sql = crewMediaQuery({ pubkey: hex('ab'), limit: 12 });
    expect(sql.text).toContain('f.pubkey = $1');
    expect(sql.text).toContain('v.pubkey = $1');
    expect(sql.text).toContain('union all');
    expect(sql.text).toContain("media_type");
    expect(sql.params[0]).toBe(hex('ab'));
    expect(sql.params[3]).toBe(12);
  });

  it('crewReppingQuery uses array containment on profiles.crews', () => {
    const sql = crewReppingQuery(hex('ab'));
    expect(sql.text).toContain('p.crews @> array[$1]::text[]');
    expect(sql.params).toEqual([hex('ab')]);
  });

  it('crewMembersQuery binds the pubkey array', () => {
    const sql = crewMembersQuery([hex('ab'), hex('cd')]);
    expect(sql.text).toContain('p.pubkey = any($1::text[])');
    expect(sql.params).toEqual([[hex('ab'), hex('cd')]]);
  });

  it('boardsQuery filters by kind when asked', () => {
    expect(boardsQuery('type').text).toContain('where b.kind = $1');
    expect(boardsQuery('type').params).toEqual(['type']);
    expect(boardsQuery().text).not.toContain('where b.kind');
  });
});
