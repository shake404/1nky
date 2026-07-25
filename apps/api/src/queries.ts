import { normalizeBoard } from '@1nky/protocol';

import type { Cursor } from './cursor.js';
import type { Sql } from './types.js';

export type { Sql };

/**
 * Every statement this service runs, built as `{ text, params }`.
 *
 * Two rules hold throughout:
 *   1. SELECT only. There is no INSERT, UPDATE, DELETE or DDL in this file,
 *      and there must never be one — writes are signed events to the relay
 *      (CLAUDE.md hard rule #4).
 *   2. Values are bound, never interpolated.
 */

/** Columns shared by every flick-shaped response. */
const FLICK_COLUMNS = `f.event_id, f.pubkey, f.created_at, f.url, f.sha256,
       f.width, f.height, f.blurhash, f.caption, f.boards`;

const WRITER_COLUMNS = `p.tag_name, p.city, p.avatar_sha256`;

/** Banned writers disappear from every public read path. */
const NOT_BANNED = `not exists (select 1 from banned_pubkeys b where b.pubkey = f.pubkey)`;

/**
 * "Buffed" flicks. The indexer hard-deletes on kind 5, so this is belt and
 * braces for the window between a deletion arriving and the row going away.
 */
const NOT_BUFFED = `not exists (
    select 1 from deletions d where d.pubkey = f.pubkey and f.event_id = any(d.targets)
  )`;

export function healthQuery(): Sql {
  return { text: 'select 1 as ok', params: [] };
}

export interface FeedOptions {
  board?: string | undefined;
  cursor?: Cursor | undefined;
  limit: number;
}

/**
 * `GET /feed` — the unified media feed: flicks (kind 20) and videos (kind 22)
 * side by side, each row tagged with `media_type` so the client renders an
 * `<img>` or a `<video>`.
 *
 * The two derived tables are UNIONed in a subquery `m`, then the board filter,
 * keyset bound, writer join and reply count are applied once on the outside.
 * Keyset pagination keys `(created_at, event_id) desc` are identical to the
 * flicks-only feed, so a page boundary never shifts when a new post lands.
 */
export function feedQuery(options: FeedOptions): Sql {
  return {
    text: `select m.event_id, m.pubkey, m.created_at, m.url, m.sha256,
       m.width, m.height, m.blurhash, m.caption, m.boards, m.media_type,
       m.poster_url, m.duration,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count
from (
  select ${FLICK_COLUMNS}, 'flick'::text as media_type,
         null::text as poster_url, null::integer as duration
  from flicks f
  where ${NOT_BANNED}
    and ${NOT_BUFFED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  where not exists (select 1 from banned_pubkeys b where b.pubkey = v.pubkey)
    and not exists (
      select 1 from deletions d where d.pubkey = v.pubkey and v.event_id = any(d.targets)
    )
) m
left join profiles p on p.pubkey = m.pubkey
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = m.event_id
) r on true
where ($1::text is null or $1::text = any(m.boards))
  and ($2::bigint is null or (m.created_at, m.event_id) < ($2::bigint, $3::text))
order by m.created_at desc, m.event_id desc
limit $4::int`,
    params: [
      options.board ?? null,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

export interface ExploreOptions {
  /** Bare city slugs (OR within the group). */
  city?: readonly string[] | undefined;
  /** Bare type values, e.g. `throwie` (OR within; prefixed to `type-*` here). */
  type?: readonly string[] | undefined;
  /** Bare surface values (OR within; prefixed to `surface-*` here). */
  surface?: readonly string[] | undefined;
  /** Bare region values (OR within; prefixed to `region-*` here). */
  region?: readonly string[] | undefined;
  /** When true, require the `legal-permission` tag. */
  legal?: boolean | undefined;
  cursor?: Cursor | undefined;
  limit: number;
}

/**
 * `GET /explore` — the unified flick+video feed filtered by facet `t` tags.
 *
 * AND across facets, OR within a repeated facet: a row must match at least one
 * value from every non-empty group, but no group narrows another. `m.boards
 * && $n::text[]` is array overlap (OR within); the groups are ANDed. City and
 * facet tags all live in the same `boards` array, so the existing GIN indexes
 * serve these reads. `GET /feed` is untouched.
 */
export function exploreQuery(options: ExploreOptions): Sql {
  const dedupe = (xs: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      if (x !== '' && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  };
  const cities = dedupe((options.city ?? []).map(normalizeBoard));
  const types = dedupe((options.type ?? []).map((t) => `type-${normalizeBoard(t)}`)).filter((s) => s !== 'type-');
  const surfaces = dedupe((options.surface ?? []).map((s) => `surface-${normalizeBoard(s)}`)).filter((s) => s !== 'surface-');
  const regions = dedupe((options.region ?? []).map((r) => `region-${normalizeBoard(r)}`)).filter((s) => s !== 'region-');
  const legal = options.legal === true ? ['legal-permission'] : [];

  return {
    text: `select m.event_id, m.pubkey, m.created_at, m.url, m.sha256,
       m.width, m.height, m.blurhash, m.caption, m.boards, m.media_type,
       m.poster_url, m.duration,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count
from (
  select ${FLICK_COLUMNS}, 'flick'::text as media_type,
         null::text as poster_url, null::integer as duration
  from flicks f
  where ${NOT_BANNED}
    and ${NOT_BUFFED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  where not exists (select 1 from banned_pubkeys b where b.pubkey = v.pubkey)
    and not exists (
      select 1 from deletions d where d.pubkey = v.pubkey and v.event_id = any(d.targets)
    )
) m
left join profiles p on p.pubkey = m.pubkey
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = m.event_id
) r on true
where ($1::text[] is null or m.boards && $1::text[])
  and ($2::text[] is null or m.boards && $2::text[])
  and ($3::text[] is null or m.boards && $3::text[])
  and ($4::text[] is null or m.boards && $4::text[])
  and ($5::text[] is null or m.boards && $5::text[])
  and ($6::bigint is null or (m.created_at, m.event_id) < ($6::bigint, $7::text))
order by m.created_at desc, m.event_id desc
limit $8::int`,
    params: [
      cities.length ? cities : null,
      types.length ? types : null,
      surfaces.length ? surfaces : null,
      regions.length ? regions : null,
      legal.length ? legal : null,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

/**
 * `GET /explore/facets` — every facet value in use, with how many media items
 * carry it, for the chip picker. One unnest-and-count over the unified
 * flicks+videos `boards` arrays; the route classifies the slugs by prefix.
 * Cache-friendly: a single aggregate over derived, public data.
 */
export function exploreFacetsQuery(): Sql {
  return {
    text: `select tag.slug as slug, count(*)::int as item_count
from (
  select f.boards as boards
  from flicks f
  where not exists (select 1 from banned_pubkeys b where b.pubkey = f.pubkey)
    and not exists (select 1 from deletions d where d.pubkey = f.pubkey and f.event_id = any(d.targets))
  union all
  select v.boards as boards
  from videos v
  where not exists (select 1 from banned_pubkeys b where b.pubkey = v.pubkey)
    and not exists (select 1 from deletions d where d.pubkey = v.pubkey and v.event_id = any(d.targets))
) m, unnest(m.boards) as tag(slug)
group by tag.slug
order by tag.slug`,
    params: [],
  };
}

export function flickQuery(eventId: string): Sql {
  return {
    text: `select ${FLICK_COLUMNS},
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count
from flicks f
left join profiles p on p.pubkey = f.pubkey
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = f.event_id
) r on true
where f.event_id = $1
  and ${NOT_BANNED}
  and ${NOT_BUFFED}`,
    params: [eventId],
  };
}

/** Every comment anchored to a root, oldest first, ready for threading. */
export function commentsQuery(rootId: string): Sql {
  return {
    text: `select c.event_id, c.parent_id, c.root_id, c.pubkey, c.created_at, c.content,
       p.tag_name, p.avatar_sha256
from comments c
left join profiles p on p.pubkey = c.pubkey
where c.root_id = $1
  and not exists (select 1 from banned_pubkeys b where b.pubkey = c.pubkey)
order by c.created_at asc, c.event_id asc`,
    params: [rootId],
  };
}

export function profileQuery(pubkey: string): Sql {
  return {
    text: `select p.pubkey, p.tag_name, p.city, p.avatar_sha256, p.crews, p.first_seen, p.updated_at,
       coalesce(s.event_count, 0) as event_count,
       s.first_event_at,
       exists (select 1 from banned_pubkeys b where b.pubkey = p.pubkey) as banned
from profiles p
left join pubkey_stats s on s.pubkey = p.pubkey
where p.pubkey = $1`,
    params: [pubkey],
  };
}

export function boardsQuery(kind?: string): Sql {
  return {
    text: `select b.slug, b.title, b.kind, b.created_at,
       coalesce(c.flick_count, 0) as flick_count,
       c.latest_at
from boards b
left join lateral (
  select count(*)::int as flick_count, max(f.created_at) as latest_at
  from flicks f
  where b.slug = any(f.boards)
) c on true
${kind ? 'where b.kind = $1' : ''}
order by b.slug asc`,
    params: kind ? [kind] : [],
  };
}

export interface WriterFlicksOptions {
  pubkey: string;
  cursor?: Cursor | undefined;
  limit: number;
}

export function writerFlicksQuery(options: WriterFlicksOptions): Sql {
  return {
    text: `select ${FLICK_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count
from flicks f
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = f.event_id
) r on true
where f.pubkey = $1
  and ($2::bigint is null or (f.created_at, f.event_id) < ($2::bigint, $3::text))
  and ${NOT_BUFFED}
order by f.created_at desc, f.event_id desc
limit $4::int`,
    params: [
      options.pubkey,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

// ---------------------------------------------------------------------------
// Crews — /crew/:pubkey. A crew page is a writer page for the crew's pubkey
// plus crew-specific chrome (roster, verified badge, repping writers).
// ---------------------------------------------------------------------------

/**
 * The crew "header": always returns exactly one row (anchored on the pubkey
 * itself, not on any one table) with whatever is known — a kind-0 profile, a
 * crew definition, and/or a site-issued badge — and nulls where data is
 * missing. The route decides whether the crew exists at all.
 */
export function crewHeaderQuery(pubkey: string): Sql {
  return {
    text: `select x.pk as pubkey,
              p.tag_name, p.city, p.avatar_sha256, p.first_seen, p.updated_at,
              c.name as crew_name, c.mark as crew_mark, c.founder_pubkey, c.founded_at,
              c.members, c.created_at as crew_created_at, c.updated_at as crew_updated_at,
              cb.verified_at, cb.verified_by
           from (select $1::text as pk) x
           left join profiles p on p.pubkey = x.pk
           left join crews c on c.crew_pubkey = x.pk
           left join crew_badges cb on cb.crew_pubkey = x.pk`,
    params: [pubkey],
  };
}

/** Profiles for a roster of member pubkeys (tag/avatar enrichment). */
export function crewMembersQuery(pubkeys: readonly string[]): Sql {
  return {
    text: `select p.pubkey, p.tag_name, p.avatar_sha256
           from profiles p
           where p.pubkey = any($1::text[])
             and not exists (select 1 from banned_pubkeys b where b.pubkey = p.pubkey)`,
    params: [[...pubkeys]],
  };
}

/** The crew's aggregated flicks + videos, keyset paginated (same shape as /feed). */
export function crewMediaQuery(options: WriterFlicksOptions): Sql {
  return {
    text: `select m.event_id, m.pubkey, m.created_at, m.url, m.sha256,
       m.width, m.height, m.blurhash, m.caption, m.boards, m.media_type,
       m.poster_url, m.duration,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count
from (
  select ${FLICK_COLUMNS}, 'flick'::text as media_type,
         null::text as poster_url, null::integer as duration
  from flicks f
  where f.pubkey = $1
    and ${NOT_BANNED}
    and ${NOT_BUFFED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  where v.pubkey = $1
    and not exists (select 1 from banned_pubkeys b where b.pubkey = v.pubkey)
    and not exists (select 1 from deletions d where d.pubkey = v.pubkey and v.event_id = any(d.targets))
) m
left join profiles p on p.pubkey = m.pubkey
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = m.event_id
) r on true
where ($2::bigint is null or (m.created_at, m.event_id) < ($2::bigint, $3::text))
order by m.created_at desc, m.event_id desc
limit $4::int`,
    params: [
      options.pubkey,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

/** Writers who self-declared this crew on their kind-0 (`profiles.crews`). */
export function crewReppingQuery(pubkey: string): Sql {
  return {
    text: `select p.pubkey, p.tag_name, p.city, p.avatar_sha256
           from profiles p
           where p.crews @> array[$1]::text[]
             and not exists (select 1 from banned_pubkeys b where b.pubkey = p.pubkey)
           order by p.tag_name asc nulls last, p.pubkey asc`,
    params: [pubkey],
  };
}

/** Board slugs implied by a free-text query, for the tag half of search. */
export function searchBoardTerms(q: string): string[] {
  const terms = new Set<string>();
  for (const word of q.split(/[\s,]+/)) {
    const slug = normalizeBoard(word);
    if (slug) terms.add(slug);
  }
  const whole = normalizeBoard(q);
  if (whole) terms.add(whole);
  return [...terms];
}

/**
 * Postgres full-text search over event content, OR a board-tag match.
 * `websearch_to_tsquery` accepts what people actually type ("quotes", -minus,
 * or) and never throws on syntax, unlike `to_tsquery`.
 */
export function searchQuery(q: string, limit: number): Sql {
  return {
    text: `select ${FLICK_COLUMNS},
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count,
       ts_rank(e.content_tsv, websearch_to_tsquery('english', $1)) as rank
from flicks f
join events e on e.id = f.event_id
left join profiles p on p.pubkey = f.pubkey
left join lateral (
  select count(*)::int as reply_count from comments c where c.root_id = f.event_id
) r on true
where (e.content_tsv @@ websearch_to_tsquery('english', $1) or f.boards && $2::text[])
  and ${NOT_BANNED}
  and ${NOT_BUFFED}
order by rank desc, f.created_at desc, f.event_id desc
limit $3::int`,
    params: [q, searchBoardTerms(q), limit],
  };
}

/**
 * The mod queue: newest reports, each with enough context to act on in one
 * screen — the reported content, its thumbnail, and how trustworthy the
 * reporter looks.
 */
export function modQueueQuery(limit: number): Sql {
  return {
    text: `select r.event_id, r.reporter, r.target_pubkey, r.target_event, r.reason, r.note,
       r.created_at,
       te.kind    as target_kind,
       te.content as target_content,
       te.created_at as target_created_at,
       tf.url      as thumbnail_url,
       tf.blurhash as thumbnail_blurhash,
       tf.boards   as target_boards,
       tp.tag_name as target_tag_name,
       rs.first_event_at as reporter_first_event_at,
       coalesce(rs.event_count, 0)  as reporter_event_count,
       coalesce(rs.report_count, 0) as reporter_report_count,
       coalesce(ts.report_count, 0) as target_report_count,
       exists (select 1 from banned_pubkeys b where b.pubkey = r.target_pubkey) as target_banned
from reports r
left join events te       on te.id = r.target_event
left join flicks tf       on tf.event_id = r.target_event
left join profiles tp     on tp.pubkey = r.target_pubkey
left join pubkey_stats rs on rs.pubkey = r.reporter
left join pubkey_stats ts on ts.pubkey = r.target_pubkey
order by r.created_at desc, r.event_id desc
limit $1::int`,
    params: [limit],
  };
}

export function banlistQuery(): Sql {
  return {
    text: `select b.pubkey, b.reason, b.banned_at, b.banned_by,
       coalesce(s.report_count, 0) as report_count,
       coalesce(s.event_count, 0)  as event_count
from banned_pubkeys b
left join pubkey_stats s on s.pubkey = b.pubkey
order by b.banned_at desc, b.pubkey asc`,
    params: [],
  };
}
