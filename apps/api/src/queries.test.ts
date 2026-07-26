import { describe, expect, it } from 'vitest';

import {
  banlistQuery,
  boardQuery,
  boardsQuery,
  boardThreadsQuery,
  commentsQuery,
  crewHeaderQuery,
  crewMediaQuery,
  crewMembersQuery,
  crewReppingQuery,
  exploreFacetsQuery,
  exploreQuery,
  feedQuery,
  flickQuery,
  happeningsQuery,
  inviteEdgesQuery,
  inviteNodeQuery,
  inviteRootsQuery,
  inviteSubtreeEdgesQuery,
  mentionsQuery,
  modQueueQuery,
  profileQuery,
  searchBoardTerms,
  searchQuery,
  searchThreadsQuery,
  searchVideosQuery,
  searchWritersQuery,
  threadQuery,
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
  boardQuery('sf'),
  boardThreadsQuery({ slug: 'sf', limit: 24 }),
  boardThreadsQuery({ limit: 24, cursor: { createdAt: 100, eventId: hex('55') } }),
  threadQuery(hex('55')),
  happeningsQuery({ limit: 24 }),
  happeningsQuery({ city: 'oakland', limit: 24, cursor: { createdAt: 1_800_000_000, eventId: hex('66') } }),
  mentionsQuery({ pubkey: hex('7a'), limit: 24 }),
  mentionsQuery({ pubkey: hex('7a'), limit: 24, cursor: { createdAt: 100, eventId: hex('33') } }),
  searchVideosQuery('burner', 24),
  searchThreadsQuery('burner', 24),
  searchWritersQuery('shake', 24),
  inviteRootsQuery(),
  inviteEdgesQuery(),
  inviteNodeQuery(hex('ab')),
  inviteSubtreeEdgesQuery(hex('ab')),
];

/**
 * Every public read that serves an event-backed row. The mod queue, the ban list
 * and the invite tree are deliberately absent — see `NOT_EXPIRED` in queries.ts.
 */
const PUBLIC_EVENT_READS = [
  ['feed', feedQuery({ limit: 24 })],
  ['explore', exploreQuery({ limit: 24 })],
  ['explore facets', exploreFacetsQuery()],
  ['flick detail', flickQuery(hex('11'))],
  ['comments', commentsQuery(hex('11'))],
  ['writer flicks', writerFlicksQuery({ pubkey: hex('ab'), limit: 24 })],
  ['crew media', crewMediaQuery({ pubkey: hex('ab'), limit: 24 })],
  ['boards', boardsQuery()],
  ['board threads', boardThreadsQuery({ slug: 'sf', limit: 24 })],
  ['thread detail', threadQuery(hex('55'))],
  ['happenings', happeningsQuery({ limit: 24 })],
  ['mentions', mentionsQuery({ pubkey: hex('7a'), limit: 24 })],
  ['search flicks', searchQuery('burner', 24)],
  ['search videos', searchVideosQuery('burner', 24)],
  ['search threads', searchThreadsQuery('burner', 24)],
] as const;

describe('the API is read-only (hard rule #4)', () => {
  it.each(ALL.map((sql, i) => [i, sql] as const))('query %i only selects', (_i, sql) => {
    const text = sql.text.toLowerCase();
    // A leading `with recursive` is still a SELECT — the invite-tree walk needs
    // one. Nothing else may lead, and no write verb may appear anywhere.
    expect(text.trimStart()).toMatch(/^(select|with recursive)\b/);
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

// ---------------------------------------------------------------------------
// The invite forest — "getting put on"
// ---------------------------------------------------------------------------

describe('the invite tree queries', () => {
  const PK = hex('ab');

  it('exposes putOn — and nothing else about the tree — on the public profile', () => {
    const text = profileQuery(PK).text;
    expect(text).toContain('from invite_edges ie where ie.child = p.pubkey) as put_on');
    // No inviter, no timestamp, no branch. A public invite graph is a public map
    // of who knows whom.
    expect(text).not.toContain('parent');
    expect(text).not.toContain('redeemed_at');
  });

  it('roots are writers who put somebody on and were never put on themselves', () => {
    const text = inviteRootsQuery().text;
    expect(text).toContain('select distinct e.parent as pubkey');
    expect(text).toContain('where not exists (select 1 from invite_edges pe where pe.child = e.parent)');
    expect(text).toContain('order by e.parent asc');
  });

  it('every node carries its stats and whether it is banned', () => {
    for (const sql of [inviteRootsQuery(), inviteEdgesQuery(), inviteSubtreeEdgesQuery(PK)]) {
      expect(sql.text).toContain('coalesce(s.event_count, 0)');
      expect(sql.text).toContain('coalesce(s.report_count, 0)');
      expect(sql.text).toContain('from banned_pubkeys b');
      expect(sql.text).toContain('p.tag_name');
    }
  });

  it('orders edges so the shaper truncation is deterministic', () => {
    expect(inviteEdgesQuery().text).toContain('order by e.redeemed_at asc, e.child asc');
    expect(inviteSubtreeEdgesQuery(PK).text).toContain('order by sub.redeemed_at asc, sub.child asc');
  });

  it('walks the subtree with the same recursive CTE the indexer cascade uses', () => {
    const text = inviteSubtreeEdgesQuery(PK).text;
    expect(text).toContain('with recursive sub as');
    expect(text).toContain('where e.parent = $1');
    expect(text).toContain('join sub on e.parent = sub.child');
    // `union`, not `union all`: dedup is what terminates a cycle.
    expect(text).not.toContain('union all');
    expect(text).toMatch(/\bunion\b/);
    expect(inviteSubtreeEdgesQuery(PK).params).toEqual([PK]);
  });

  it('returns a root node for a writer with no profile and no invites', () => {
    const text = inviteNodeQuery(PK).text;
    // Selected from a constant, not from `profiles`, so there is always a row.
    expect(text).toContain('select $1::text as pubkey');
    expect(text).toContain('left join invite_edges ie on ie.child = $1');
    expect(text).toContain('ie.redeemed_at as invited_at');
    expect(inviteNodeQuery(PK).params).toEqual([PK]);
  });
});

// ---------------------------------------------------------------------------
// NIP-40 at read time
// ---------------------------------------------------------------------------

describe('expired events are filtered at read time, not just swept', () => {
  it.each(PUBLIC_EVENT_READS)('%s excludes an expired row', (_name, sql) => {
    expect(sql.text).toContain('e.expires_at is null or e.expires_at > extract(epoch from now())::bigint');
  });

  it.each(PUBLIC_EVENT_READS)('%s joins events to get at expires_at', (_name, sql) => {
    // A derived table has no expiry of its own — the one copy lives in `events`.
    expect(sql.text).toMatch(/join events e on e\.id = \w+\.event_id/);
  });

  it('binds no clock: `now()` is evaluated by Postgres, not by this process', () => {
    for (const [, sql] of PUBLIC_EVENT_READS) {
      expect(sql.params).not.toContain(Math.floor(Date.now() / 1000));
    }
  });

  it('does not filter the mod queue — a mod sees reported content until it is swept', () => {
    expect(modQueueQuery(50).text).not.toContain('expires_at');
    expect(banlistQuery().text).not.toContain('expires_at');
  });

  it('leaves an expired reply out of a reply count as well as out of a thread', () => {
    expect(feedQuery({ limit: 10 }).text).toContain('join events ce on ce.id = c.event_id');
    expect(commentsQuery(hex('11')).text).toContain('e.expires_at is null');
  });
});

// ---------------------------------------------------------------------------
// Boards and threads
// ---------------------------------------------------------------------------

describe('boardsQuery', () => {
  it('counts threads alongside flicks, per board', () => {
    const text = boardsQuery().text;
    expect(text).toContain('thread_count');
    expect(text).toContain('from threads t');
    expect(text).toContain('flick_count');
  });

  it('keeps a board with neither a flick nor a thread in the list', () => {
    // Lateral + LEFT JOIN, not an inner join or a GROUP BY over posts.
    const text = boardsQuery().text;
    expect(text).toContain('left join lateral');
    expect(text).toContain('coalesce(th.thread_count, 0)');
  });
});

describe('boardQuery', () => {
  it('always returns one row, anchored on the slug rather than on boards', () => {
    const sql = boardQuery('sf');
    expect(sql.text).toContain('from (select $1::text as slug) x');
    expect(sql.text).toContain('left join boards b on b.slug = x.slug');
    expect(sql.text).toContain('as has_media');
    expect(sql.params).toEqual(['sf']);
  });
});

describe('boardThreadsQuery', () => {
  it('orders by newest activity, not by when the thread was started', () => {
    const sql = boardThreadsQuery({ slug: 'sf', limit: 24 });
    expect(sql.text).toContain('greatest(t.created_at, coalesce(r.last_reply_at, t.created_at)) as sort_at');
    expect(sql.text).toContain('order by s.sort_at desc, s.event_id desc');
  });

  it('paginates by keyset on the same key it sorts by', () => {
    const sql = boardThreadsQuery({ slug: 'sf', limit: 24, cursor: { createdAt: 100, eventId: hex('55') } });
    expect(sql.text).toContain('(s.sort_at, s.event_id) < ($2::bigint, $3::text)');
    expect(sql.text).not.toContain('offset');
    expect(sql.params).toEqual(['sf', 100, hex('55'), 24]);
  });

  it('makes the board filter optional in one statement', () => {
    const sql = boardThreadsQuery({ limit: 10 });
    expect(sql.params).toEqual([null, null, null, 10]);
    expect(sql.text).toContain('$1::text is null or $1::text = any(s.boards)');
  });

  it('cuts the excerpt in Postgres so a 60KB note never crosses the wire', () => {
    expect(boardThreadsQuery({ limit: 10 }).text).toContain('left(e.content, 160) as excerpt');
  });

  it('hides banned writers and buffed threads', () => {
    const text = boardThreadsQuery({ limit: 10 }).text;
    expect(text).toContain('b.pubkey = t.pubkey');
    expect(text).toContain('t.event_id = any(d.targets)');
  });

  it('reports the expiry so the client can show a beef countdown', () => {
    expect(boardThreadsQuery({ limit: 10 }).text).toContain('e.expires_at');
  });
});

describe('threadQuery', () => {
  it('joins the OP content out of events rather than duplicating it', () => {
    const sql = threadQuery(hex('55'));
    expect(sql.text).toContain('from threads t');
    expect(sql.text).toContain('join events e on e.id = t.event_id');
    expect(sql.text).toContain('e.content');
    expect(sql.text).toContain('where t.event_id = $1');
    expect(sql.params).toEqual([hex('55')]);
  });

  it('hides a banned writer and a buffed thread', () => {
    const text = threadQuery(hex('55')).text;
    expect(text).toContain('b.pubkey = t.pubkey');
    expect(text).toContain('t.event_id = any(d.targets)');
  });
});

// ---------------------------------------------------------------------------
// Happenings — a thread with a date on it
// ---------------------------------------------------------------------------

describe('mentionsQuery', () => {
  const NAMED = hex('7a');

  it('reads the mentions table, which only holds deliberate ones', () => {
    const sql = mentionsQuery({ pubkey: NAMED, limit: 24 });
    expect(sql.text).toContain('from mentions m');
    expect(sql.text).toContain('m.mentioned_pubkey = $1');
    expect(sql.params[0]).toBe(NAMED);
    // The marker rule lives in the indexer, so this read never inspects tags.
    expect(sql.text).not.toContain('tags');
  });

  it('paginates newest first by keyset, like every other paged read', () => {
    const sql = mentionsQuery({
      pubkey: NAMED,
      limit: 24,
      cursor: { createdAt: 1_700_000_100, eventId: hex('33') },
    });
    expect(sql.text).toContain('order by m.created_at desc, m.event_id desc');
    expect(sql.text).toContain('(m.created_at, m.event_id) < ($2::bigint, $3::text)');
    expect(sql.text).not.toContain('offset');
    expect(sql.params).toEqual([NAMED, 1_700_000_100, hex('33'), 24]);
  });

  it('carries where it happened, so the row is a door and not an id', () => {
    const text = mentionsQuery({ pubkey: NAMED, limit: 24 }).text;
    expect(text).toContain('as root_type');
    expect(text).toContain('t.subject as root_subject');
    expect(text).toContain('as root_excerpt');
  });

  it('requires the thread to still be there, not just the comment', () => {
    const text = mentionsQuery({ pubkey: NAMED, limit: 24 }).text;
    // An inner join: a mention whose thread expired has nowhere to link to.
    expect(text).toContain('join events re on re.id = m.root_id');
    expect(text).toContain('re.expires_at is null or re.expires_at > extract(epoch from now())');
  });

  it('hides a banned writer and a buffed comment', () => {
    const text = mentionsQuery({ pubkey: NAMED, limit: 24 }).text;
    expect(text).toContain('b.pubkey = c.pubkey');
    expect(text).toContain('c.event_id = any(d.targets)');
  });

  it('cuts the excerpt in Postgres so a 64KB comment never crosses the wire', () => {
    expect(mentionsQuery({ pubkey: NAMED, limit: 24 }).text).toContain(
      'left(c.content, 240) as content',
    );
  });

  it('stores and reads no seen state — that lives on the device', () => {
    const text = mentionsQuery({ pubkey: NAMED, limit: 24 }).text.toLowerCase();
    expect(text).not.toContain('seen');
    expect(text).not.toContain('read_at');
  });
});

describe('happeningsQuery', () => {
  it('selects only dated threads, on the same predicate as the partial index', () => {
    const text = happeningsQuery({ limit: 24 }).text;
    expect(text).toContain('from threads t');
    expect(text).toContain('where t.happening_at is not null');
  });

  it('orders soonest first — a happenings list is not a board', () => {
    const text = happeningsQuery({ limit: 24 }).text;
    expect(text).toContain('order by s.happening_at asc, s.event_id asc');
    expect(text).not.toContain('sort_at');
  });

  it('paginates forwards by keyset on the date it sorts by', () => {
    const sql = happeningsQuery({
      limit: 24,
      cursor: { createdAt: 1_800_000_000, eventId: hex('66') },
    });
    // `>`, not `<`: the order is ascending, so the page bound runs the other way.
    expect(sql.text).toContain('(s.happening_at, s.event_id) > ($2::bigint, $3::text)');
    expect(sql.text).not.toContain('offset');
    expect(sql.params).toEqual([null, 1_800_000_000, hex('66'), 24]);
  });

  it('filters by city with the bound board slug, optionally', () => {
    const sql = happeningsQuery({ city: 'oakland', limit: 10 });
    expect(sql.text).toContain('$1::text is null or $1::text = any(s.boards)');
    expect(sql.params).toEqual(['oakland', null, null, 10]);
    expect(happeningsQuery({ limit: 10 }).params[0]).toBeNull();
  });

  it('drops a happening seven days after it happened, defensively', () => {
    // NIP-40 is the real mechanism; this is the belt to its braces, for a
    // happening published with a longer expiry or none at all.
    const text = happeningsQuery({ limit: 10 }).text;
    expect(text).toContain('s.happening_at + 604800 > extract(epoch from now())::bigint');
  });

  it('binds no clock of its own: the window is evaluated by Postgres', () => {
    const sql = happeningsQuery({ limit: 10 });
    expect(sql.params).not.toContain(Math.floor(Date.now() / 1000));
    expect(sql.params).not.toContain(604_800);
  });

  it('hides banned writers, buffed threads and expired rows', () => {
    const text = happeningsQuery({ limit: 10 }).text;
    expect(text).toContain('b.pubkey = t.pubkey');
    expect(text).toContain('t.event_id = any(d.targets)');
    expect(text).toContain('e.expires_at is null or e.expires_at > extract(epoch from now())::bigint');
  });

  it('carries the boards, the excerpt, the expiry and a reply count', () => {
    const text = happeningsQuery({ limit: 10 }).text;
    expect(text).toContain('s.boards');
    expect(text).toContain('left(e.content, 160) as excerpt');
    expect(text).toContain('s.expires_at');
    expect(text).toContain('coalesce(r.reply_count, 0) as reply_count');
  });
});

describe('every thread read reports happening_at', () => {
  it.each([
    ['board threads', boardThreadsQuery({ slug: 'sf', limit: 10 })],
    ['thread detail', threadQuery(hex('55'))],
    ['search threads', searchThreadsQuery('jam', 10)],
    ['happenings', happeningsQuery({ limit: 10 })],
  ] as const)('%s selects the column', (_name, sql) => {
    expect(sql.text).toContain('happening_at');
  });
});

describe('search over videos and threads', () => {
  it('searches videos with the same FTS join and tags them as video rows', () => {
    const sql = searchVideosQuery('burner', 10);
    expect(sql.text).toContain('from videos v');
    expect(sql.text).toContain("websearch_to_tsquery('english', $1)");
    expect(sql.text).toContain("'video'::text as media_type");
    expect(sql.text).toContain('v.boards && $2::text[]');
    expect(sql.params).toEqual(['burner', ['burner'], 10]);
  });

  it('ranks a thread on its subject as well as its body, subject weighted up', () => {
    const sql = searchThreadsQuery('oakland', 10);
    expect(sql.text).toContain("to_tsvector('english', coalesce(t.subject, ''))");
    expect(sql.text).toContain("+ 2 * ts_rank(to_tsvector('english', coalesce(t.subject, ''))");
    expect(sql.text).toContain('order by rank desc');
  });

  it('matches a thread by board tag too', () => {
    expect(searchThreadsQuery('oakland', 10).text).toContain('t.boards && $2::text[]');
  });
});

// ---------------------------------------------------------------------------
// Search over writers — the half that was missing: typing a tag has to find
// the writer who uses it, not only the posts that mention it.
// ---------------------------------------------------------------------------

describe('searchWritersQuery', () => {
  it('matches a tag name anywhere in it, case-insensitively', () => {
    const sql = searchWritersQuery('shake', 10);
    expect(sql.text).toContain('from profiles p');
    expect(sql.text).toContain('p.tag_name ilike $2');
    expect(sql.params).toEqual(['shake', '%shake%', 'shake%', 10]);
  });

  it('ranks an exact tag first, then a prefix, then anything else', () => {
    const text = searchWritersQuery('shake', 10).text;
    expect(text).toContain('when lower(p.tag_name) = lower($1) then 0');
    expect(text).toContain('when p.tag_name ilike $3 then 1');
    expect(text).toContain('else 2');
    expect(text).toContain('order by match_rank asc');
  });

  it('breaks a tie deterministically, so the same rows always page the same', () => {
    const text = searchWritersQuery('shake', 10).text;
    expect(text).toContain('length(p.tag_name) asc');
    expect(text).toContain('p.pubkey asc');
    expect(text).not.toContain('offset');
  });

  it('hides banned writers, like every other public read', () => {
    expect(searchWritersQuery('shake', 10).text).toContain(
      'not exists (select 1 from banned_pubkeys b where b.pubkey = p.pubkey)',
    );
  });

  it('leaves out a writer who has never named themselves', () => {
    expect(searchWritersQuery('shake', 10).text).toContain("coalesce(p.tag_name, '') <> ''");
  });

  it('escapes the wildcards somebody could type, so "%" is not "everybody"', () => {
    const sql = searchWritersQuery('50%_off\\', 10);
    expect(sql.params[1]).toBe('%50\\%\\_off\\\\%');
    expect(sql.params[2]).toBe('50\\%\\_off\\\\%');
  });

  it('carries exactly the writer columns the rest of the API reports', () => {
    const text = searchWritersQuery('shake', 10).text;
    for (const column of ['p.pubkey', 'p.tag_name', 'p.city', 'p.avatar_sha256']) {
      expect(text).toContain(column);
    }
    // Nothing about who put them on, and no bio — this is a list row.
    expect(text).not.toContain('invite_edges');
    expect(text).not.toContain('p.about');
  });

  it('caps how many come back with the bound limit', () => {
    expect(searchWritersQuery('shake', 7).text).toContain('limit $4::int');
    expect(searchWritersQuery('shake', 7).params[3]).toBe(7);
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
