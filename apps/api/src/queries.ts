import { HAPPENING_GRACE_SECONDS, normalizeBoard } from '@1nky/protocol';

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

/**
 * Columns shared by every thread-shaped response. `t` is `threads`.
 *
 * `happening_at` rides along on all of them: a happening is a thread, so every
 * thread read reports its date (null for the ordinary ones) rather than a
 * separate shape existing for the dated ones.
 */
const THREAD_COLUMNS = `t.event_id, t.pubkey, t.subject, t.boards, t.created_at, t.happening_at`;

/** Banned writers disappear from every public read path. */
const notBanned = (pubkeyColumn: string): string =>
  `not exists (select 1 from banned_pubkeys b where b.pubkey = ${pubkeyColumn})`;

/**
 * "Buffed" rows. The indexer hard-deletes on kind 5, so this is belt and
 * braces for the window between a deletion arriving and the row going away.
 */
const notBuffed = (pubkeyColumn: string, idColumn: string): string => `not exists (
    select 1 from deletions d where d.pubkey = ${pubkeyColumn} and ${idColumn} = any(d.targets)
  )`;

const NOT_BANNED = notBanned('f.pubkey');
const NOT_BUFFED = notBuffed('f.pubkey', 'f.event_id');

/**
 * NIP-40, applied at read time as well as by the sweep.
 *
 * `events.expires_at` is enforced by two background jobs — strfry purges an
 * expired event roughly every 9s and the indexer sweeps Postgres every 60s —
 * but "roughly" is not "immediately". Between an event's expiry and the next
 * sweep its row is still here, and a beef that says it lasts 24h has to be gone
 * at 24h, not at 24h plus a minute. So every public read that serves an
 * event-backed row joins `events e` and applies this predicate.
 *
 * The one deliberate exception is the mod queue: a moderator may need to see
 * reported content right up until it is actually swept.
 */
const NOT_EXPIRED = `(e.expires_at is null or e.expires_at > extract(epoch from now())::bigint)`;

/** The same rule for the `comments -> events` join inside a reply count. */
const NOT_EXPIRED_COMMENT = `(ce.expires_at is null or ce.expires_at > extract(epoch from now())::bigint)`;

/**
 * The reply-count lateral, shared by every read that reports one. It also
 * carries `last_reply_at`, which is what orders a board by liveliest thread.
 *
 * An expired comment counts towards a reply total no more than it appears in a
 * thread, hence the join.
 */
const replyCounts = (idColumn: string): string => `left join lateral (
  select count(*)::int as reply_count, max(c.created_at) as last_reply_at
  from comments c
  join events ce on ce.id = c.event_id
  where c.root_id = ${idColumn}
    and ${NOT_EXPIRED_COMMENT}
) r on true`;

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
  join events e on e.id = f.event_id
  where ${NOT_BANNED}
    and ${NOT_BUFFED}
    and ${NOT_EXPIRED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  join events e on e.id = v.event_id
  where ${notBanned('v.pubkey')}
    and ${notBuffed('v.pubkey', 'v.event_id')}
    and ${NOT_EXPIRED}
) m
left join profiles p on p.pubkey = m.pubkey
${replyCounts('m.event_id')}
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
  join events e on e.id = f.event_id
  where ${NOT_BANNED}
    and ${NOT_BUFFED}
    and ${NOT_EXPIRED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  join events e on e.id = v.event_id
  where ${notBanned('v.pubkey')}
    and ${notBuffed('v.pubkey', 'v.event_id')}
    and ${NOT_EXPIRED}
) m
left join profiles p on p.pubkey = m.pubkey
${replyCounts('m.event_id')}
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
  join events e on e.id = f.event_id
  where ${NOT_BANNED}
    and ${NOT_BUFFED}
    and ${NOT_EXPIRED}
  union all
  select v.boards as boards
  from videos v
  join events e on e.id = v.event_id
  where ${notBanned('v.pubkey')}
    and ${notBuffed('v.pubkey', 'v.event_id')}
    and ${NOT_EXPIRED}
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
join events e on e.id = f.event_id
left join profiles p on p.pubkey = f.pubkey
${replyCounts('f.event_id')}
where f.event_id = $1
  and ${NOT_BANNED}
  and ${NOT_BUFFED}
  and ${NOT_EXPIRED}`,
    params: [eventId],
  };
}

/**
 * Every comment anchored to a root, oldest first, ready for threading. Shared
 * by `GET /flick/:id` and `GET /thread/:id` — a reply is a reply either way.
 */
export function commentsQuery(rootId: string): Sql {
  return {
    text: `select c.event_id, c.parent_id, c.root_id, c.pubkey, c.created_at, c.content,
       p.tag_name, p.avatar_sha256
from comments c
join events e on e.id = c.event_id
left join profiles p on p.pubkey = c.pubkey
where c.root_id = $1
  and ${notBanned('c.pubkey')}
  and ${NOT_EXPIRED}
order by c.created_at asc, c.event_id asc`,
    params: [rootId],
  };
}

/**
 * `put_on` is the ONLY thing about the invite forest that is public: a boolean,
 * "was this writer vouched for by somebody already here". Who put them on, when,
 * and what the rest of the branch looks like are mod-only (`GET /mod/tree`) —
 * publishing the graph would turn "getting put on" into a map of who knows whom,
 * which is exactly the thing a writer cannot afford to have public.
 */
export function profileQuery(pubkey: string): Sql {
  return {
    text: `select p.pubkey, p.tag_name, p.city, p.avatar_sha256, p.crews, p.first_seen, p.updated_at,
       coalesce(s.event_count, 0) as event_count,
       s.first_event_at,
       exists (select 1 from banned_pubkeys b where b.pubkey = p.pubkey) as banned,
       exists (select 1 from invite_edges ie where ie.child = p.pubkey) as put_on
from profiles p
left join pubkey_stats s on s.pubkey = p.pubkey
where p.pubkey = $1`,
    params: [pubkey],
  };
}

/**
 * `GET /boards` — every board with how busy it is.
 *
 * Two cheap lateral counts rather than one grouped scan: a board's media count
 * and its thread count come from different tables, and a lateral keeps a board
 * with neither in the list (which is what a freshly registered board is).
 * `latest_at` is media-only, unchanged, so the field means what it always did.
 */
export function boardsQuery(kind?: string): Sql {
  return {
    text: `select b.slug, b.title, b.kind, b.region_slug, b.created_at,
       coalesce(c.flick_count, 0) as flick_count,
       c.latest_at,
       coalesce(th.thread_count, 0) as thread_count
from boards b
left join lateral (
  select count(*)::int as flick_count, max(f.created_at) as latest_at
  from flicks f
  join events e on e.id = f.event_id
  where b.slug = any(f.boards)
    and ${NOT_BANNED}
    and ${NOT_BUFFED}
    and ${NOT_EXPIRED}
) c on true
left join lateral (
  select count(*)::int as thread_count
  from threads t
  join events e on e.id = t.event_id
  where b.slug = any(t.boards)
    and ${notBanned('t.pubkey')}
    and ${notBuffed('t.pubkey', 't.event_id')}
    and ${NOT_EXPIRED}
) th on true
${kind ? 'where b.kind = $1' : ''}
order by b.slug asc`,
    params: kind ? [kind] : [],
  };
}

// ---------------------------------------------------------------------------
// Boards and threads — GET /board/:slug, GET /thread/:id
// ---------------------------------------------------------------------------

/**
 * The board "header". Anchored on the slug itself rather than on `boards`, so
 * it always returns exactly one row: a board that exists only because writers
 * tagged it (never registered, so no `boards` row yet) still has a title of
 * null and `has_media` true, and the route decides from that whether the board
 * exists at all.
 */
export function boardQuery(slug: string): Sql {
  return {
    text: `select x.slug as slug, b.title, b.kind, b.region_slug,
       exists (
         select 1 from flicks f
         join events e on e.id = f.event_id
         where x.slug = any(f.boards) and ${NOT_EXPIRED}
       ) as has_media
from (select $1::text as slug) x
left join boards b on b.slug = x.slug`,
    params: [slug],
  };
}

export interface BoardThreadsOptions {
  slug?: string | undefined;
  cursor?: Cursor | undefined;
  limit: number;
}

/**
 * `GET /board/:slug` — a board's threads, liveliest first.
 *
 * The sort key is `greatest(created_at, last_reply_at)`: a thread with a fresh
 * reply floats, which is what a board is for. Because that is a computed value
 * it is produced in the inner select and both filtered and ordered on the
 * outside, so the keyset page bound `(sort_at, event_id)` stays exact rather
 * than approximate — a page boundary cannot shift under a scrolling reader.
 *
 * `excerpt` is the first 160 characters of the OP, cut in Postgres so a 60KB
 * note never crosses the wire to be thrown away by the client.
 */
export function boardThreadsQuery(options: BoardThreadsOptions): Sql {
  return {
    text: `select s.event_id, s.pubkey, s.subject, s.excerpt, s.created_at, s.expires_at,
       s.happening_at, s.reply_count, s.last_reply_at, s.sort_at,
       s.tag_name, s.city, s.avatar_sha256
from (
  select ${THREAD_COLUMNS},
         e.expires_at,
         left(e.content, 160) as excerpt,
         ${WRITER_COLUMNS},
         coalesce(r.reply_count, 0) as reply_count,
         r.last_reply_at,
         greatest(t.created_at, coalesce(r.last_reply_at, t.created_at)) as sort_at
  from threads t
  join events e on e.id = t.event_id
  left join profiles p on p.pubkey = t.pubkey
  ${replyCounts('t.event_id')}
  where ${notBanned('t.pubkey')}
    and ${notBuffed('t.pubkey', 't.event_id')}
    and ${NOT_EXPIRED}
) s
where ($1::text is null or $1::text = any(s.boards))
  and ($2::bigint is null or (s.sort_at, s.event_id) < ($2::bigint, $3::text))
order by s.sort_at desc, s.event_id desc
limit $4::int`,
    params: [
      options.slug ?? null,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

export interface HappeningsOptions {
  /** City board slug to narrow to, already normalised. */
  city?: string | undefined;
  cursor?: Cursor | undefined;
  limit: number;
}

/**
 * `GET /happenings` — dated threads, soonest first.
 *
 * Three things separate this from `boardThreadsQuery`, which is otherwise the
 * same read:
 *
 *   1. `happening_at is not null` — the whole selection rule. It is the same
 *      predicate as the partial index in migration 008, so this read uses it.
 *   2. `happening_at asc` — a board sorts by newest activity because it is a
 *      conversation; a happenings list sorts by *soonest*, because it answers
 *      "what is coming up". The keyset bound is therefore `>` rather than `<`.
 *   3. The 7-day window. NIP-40 already removes a happening a week after it
 *      happens (`buildThreadOp` sets that expiration), and `NOT_EXPIRED` filters
 *      what the sweep has not caught up with — but a happening published with an
 *      explicit longer expiry, or with none at all, would otherwise sit at the
 *      top of the list forever with a date in the past. So the window is
 *      re-applied here, defensively, from `happening_at` itself.
 *
 * `604800` is spelled as a literal rather than bound: it is `HAPPENING_GRACE_SECONDS`
 * from @1nky/protocol, a constant of the protocol and not a value from a caller.
 */
export function happeningsQuery(options: HappeningsOptions): Sql {
  return {
    text: `select s.event_id, s.pubkey, s.subject, s.excerpt, s.boards, s.created_at,
       s.expires_at, s.happening_at, s.reply_count, s.last_reply_at,
       s.tag_name, s.city, s.avatar_sha256
from (
  select ${THREAD_COLUMNS},
         e.expires_at,
         left(e.content, 160) as excerpt,
         ${WRITER_COLUMNS},
         coalesce(r.reply_count, 0) as reply_count,
         r.last_reply_at
  from threads t
  join events e on e.id = t.event_id
  left join profiles p on p.pubkey = t.pubkey
  ${replyCounts('t.event_id')}
  where t.happening_at is not null
    and ${notBanned('t.pubkey')}
    and ${notBuffed('t.pubkey', 't.event_id')}
    and ${NOT_EXPIRED}
) s
where ($1::text is null or $1::text = any(s.boards))
  and s.happening_at + ${String(HAPPENING_GRACE_SECONDS)} > extract(epoch from now())::bigint
  and ($2::bigint is null or (s.happening_at, s.event_id) > ($2::bigint, $3::text))
order by s.happening_at asc, s.event_id asc
limit $4::int`,
    params: [
      options.city ?? null,
      options.cursor?.createdAt ?? null,
      options.cursor?.eventId ?? null,
      options.limit,
    ],
  };
}

/**
 * `GET /thread/:id` — one thread OP with its content and expiry. The replies
 * come from `commentsQuery`, the same one `GET /flick/:id` uses.
 */
export function threadQuery(eventId: string): Sql {
  return {
    text: `select ${THREAD_COLUMNS},
       e.content, e.expires_at,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count,
       r.last_reply_at
from threads t
join events e on e.id = t.event_id
left join profiles p on p.pubkey = t.pubkey
${replyCounts('t.event_id')}
where t.event_id = $1
  and ${notBanned('t.pubkey')}
  and ${notBuffed('t.pubkey', 't.event_id')}
  and ${NOT_EXPIRED}`,
    params: [eventId],
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
join events e on e.id = f.event_id
${replyCounts('f.event_id')}
where f.pubkey = $1
  and ($2::bigint is null or (f.created_at, f.event_id) < ($2::bigint, $3::text))
  and ${NOT_BUFFED}
  and ${NOT_EXPIRED}
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
  join events e on e.id = f.event_id
  where f.pubkey = $1
    and ${NOT_BANNED}
    and ${NOT_BUFFED}
    and ${NOT_EXPIRED}
  union all
  select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
         v.width, v.height, v.blurhash, v.caption, v.boards,
         'video'::text as media_type,
         v.poster_url, v.duration
  from videos v
  join events e on e.id = v.event_id
  where v.pubkey = $1
    and ${notBanned('v.pubkey')}
    and ${notBuffed('v.pubkey', 'v.event_id')}
    and ${NOT_EXPIRED}
) m
left join profiles p on p.pubkey = m.pubkey
${replyCounts('m.event_id')}
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

/** `websearch_to_tsquery('english', $1)`, spelled once. */
const TSQUERY = `websearch_to_tsquery('english', $1)`;

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
       ts_rank(e.content_tsv, ${TSQUERY}) as rank
from flicks f
join events e on e.id = f.event_id
left join profiles p on p.pubkey = f.pubkey
${replyCounts('f.event_id')}
where (e.content_tsv @@ ${TSQUERY} or f.boards && $2::text[])
  and ${NOT_BANNED}
  and ${NOT_BUFFED}
  and ${NOT_EXPIRED}
order by rank desc, f.created_at desc, f.event_id desc
limit $3::int`,
    params: [q, searchBoardTerms(q), limit],
  };
}

/**
 * The same search over `videos`. A separate statement rather than a UNION with
 * the flicks half, because the two are ranked and returned separately — the
 * `flicks` field of the response is unchanged for every existing client, and
 * `videos` is additive.
 */
export function searchVideosQuery(q: string, limit: number): Sql {
  return {
    text: `select v.event_id, v.pubkey, v.created_at, v.url, v.sha256,
       v.width, v.height, v.blurhash, v.caption, v.boards,
       'video'::text as media_type, v.poster_url, v.duration,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count,
       ts_rank(e.content_tsv, ${TSQUERY}) as rank
from videos v
join events e on e.id = v.event_id
left join profiles p on p.pubkey = v.pubkey
${replyCounts('v.event_id')}
where (e.content_tsv @@ ${TSQUERY} or v.boards && $2::text[])
  and ${notBanned('v.pubkey')}
  and ${notBuffed('v.pubkey', 'v.event_id')}
  and ${NOT_EXPIRED}
order by rank desc, v.created_at desc, v.event_id desc
limit $3::int`,
    params: [q, searchBoardTerms(q), limit],
  };
}

/**
 * The same search over threads. A thread has two searchable pieces of text —
 * the OP's content (already indexed as `events.content_tsv`) and its subject —
 * so both are matched and both contribute to the rank, with the subject
 * weighted above the body: a thread *titled* "oakland" is a better hit for
 * "oakland" than one that merely mentions it.
 */
export function searchThreadsQuery(q: string, limit: number): Sql {
  const subjectTsv = `to_tsvector('english', coalesce(t.subject, ''))`;
  return {
    text: `select ${THREAD_COLUMNS},
       e.expires_at,
       left(e.content, 160) as excerpt,
       ${WRITER_COLUMNS},
       coalesce(r.reply_count, 0) as reply_count,
       r.last_reply_at,
       ts_rank(e.content_tsv, ${TSQUERY})
         + 2 * ts_rank(${subjectTsv}, ${TSQUERY}) as rank
from threads t
join events e on e.id = t.event_id
left join profiles p on p.pubkey = t.pubkey
${replyCounts('t.event_id')}
where (e.content_tsv @@ ${TSQUERY}
       or ${subjectTsv} @@ ${TSQUERY}
       or t.boards && $2::text[])
  and ${notBanned('t.pubkey')}
  and ${notBuffed('t.pubkey', 't.event_id')}
  and ${NOT_EXPIRED}
order by rank desc, t.created_at desc, t.event_id desc
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

// ---------------------------------------------------------------------------
// The invite forest — mod-only. Two queries per view (the nodes, then the
// edges), assembled into a tree in `shape.ts` rather than in SQL, because the
// depth and node caps have to be applied somewhere a test can see them.
// ---------------------------------------------------------------------------

/** Everything a tree node shows. `$1`-free so both views can share it. */
const INVITE_NODE_COLUMNS = `p.tag_name,
       coalesce(s.event_count, 0)  as event_count,
       coalesce(s.report_count, 0) as report_count`;

const inviteNodeJoins = (pubkeyColumn: string): string => `left join profiles p     on p.pubkey = ${pubkeyColumn}
left join pubkey_stats s on s.pubkey = ${pubkeyColumn}`;

/**
 * The roots of the forest: writers who have put somebody on but were never put
 * on themselves. Anyone with no edge at all — never invited, never invited
 * anybody — is not in the forest and is deliberately absent.
 */
export function inviteRootsQuery(): Sql {
  return {
    text: `select distinct e.parent as pubkey,
       ${INVITE_NODE_COLUMNS},
       exists (select 1 from banned_pubkeys b where b.pubkey = e.parent) as banned
from invite_edges e
${inviteNodeJoins('e.parent')}
where not exists (select 1 from invite_edges pe where pe.child = e.parent)
order by e.parent asc`,
    params: [],
  };
}

/**
 * Every edge in the forest, oldest redemption first. The shaper walks these into
 * a tree, so the ORDER BY is what makes its truncation deterministic: the same
 * rows always produce the same 2000 nodes.
 */
export function inviteEdgesQuery(): Sql {
  return {
    text: `select e.child as pubkey, e.parent, e.redeemed_at as invited_at,
       ${INVITE_NODE_COLUMNS},
       exists (select 1 from banned_pubkeys b where b.pubkey = e.child) as banned
from invite_edges e
${inviteNodeJoins('e.child')}
order by e.redeemed_at asc, e.child asc`,
    params: [],
  };
}

/**
 * One writer as a tree root, whether or not they are in the forest at all.
 *
 * `select $1 as pubkey` rather than `from profiles`: a mod asking about a writer
 * with no profile event and no invites gets a lone node with zeroes, which is the
 * true answer, instead of a 404 that reads like the endpoint is broken.
 * `invited_at` is their own edge's, or null when nobody put them on.
 */
export function inviteNodeQuery(pubkey: string): Sql {
  return {
    text: `select $1::text as pubkey,
       ie.redeemed_at as invited_at,
       p.tag_name,
       coalesce(s.event_count, 0)  as event_count,
       coalesce(s.report_count, 0) as report_count,
       exists (select 1 from banned_pubkeys b where b.pubkey = $1) as banned
from (select 1) one
left join invite_edges ie on ie.child = $1
left join profiles p      on p.pubkey = $1
left join pubkey_stats s  on s.pubkey = $1`,
    params: [pubkey],
  };
}

/**
 * Every edge below one writer, transitively — the "ban the whole branch" preview.
 *
 * `union` (not `union all`) deduplicates, which is what makes this terminate on a
 * cycle: A puts B on, then later B puts A on, which is legal because A had no
 * parent at the time. Same reason as `banSubtree` in the indexer, and the two
 * must agree — this endpoint is what a moderator reads before signing that ban.
 */
export function inviteSubtreeEdgesQuery(pubkey: string): Sql {
  return {
    text: `with recursive sub as (
  select e.child, e.parent, e.redeemed_at from invite_edges e where e.parent = $1
  union
  select e.child, e.parent, e.redeemed_at from invite_edges e join sub on e.parent = sub.child
)
select sub.child as pubkey, sub.parent, sub.redeemed_at as invited_at,
       ${INVITE_NODE_COLUMNS},
       exists (select 1 from banned_pubkeys b where b.pubkey = sub.child) as banned
from sub
${inviteNodeJoins('sub.child')}
order by sub.redeemed_at asc, sub.child asc`,
    params: [pubkey],
  };
}
