-- 001_init.sql — 1NKY index schema (tables only; indexes live in 002).
--
-- CARDINAL RULE (CLAUDE.md hard rule #1): this database cannot identify a
-- client. There are no columns for network addresses, no user-agent columns,
-- no session tables, nothing that ties a row to a connection. The only
-- identity that exists here is the writer's own public key, which they chose
-- to publish in a signed event. `src/schema.test.ts` enforces this by parsing
-- every file in this directory.
--
-- Postgres is a REBUILDABLE CACHE. The relay is the source of truth. Anything
-- in here can be truncated and replayed (`pnpm --filter @1nky/indexer rebuild`).

-- ---------------------------------------------------------------------------
-- events — every signed event the relay accepted, verbatim.
-- ---------------------------------------------------------------------------
create table if not exists events (
  id          text primary key,
  pubkey      text        not null,
  kind        integer     not null,
  created_at  bigint      not null,
  content     text        not null default '',
  tags        jsonb       not null default '[]'::jsonb,
  raw         jsonb       not null,
  -- NIP-40. Null means permanent. The 60s sweep deletes rows past this.
  expires_at  bigint,
  indexed_at  timestamptz not null default now(),
  -- Full-text search vector, maintained by Postgres. Two-argument
  -- to_tsvector with a literal config is IMMUTABLE, so it is generatable.
  content_tsv tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored
);

-- ---------------------------------------------------------------------------
-- flicks — kind 20 photo posts, denormalised for the feed.
-- ---------------------------------------------------------------------------
create table if not exists flicks (
  event_id   text primary key references events (id) on delete cascade,
  pubkey     text   not null,
  created_at bigint not null,
  url        text   not null,
  sha256     text   not null,
  width      integer,
  height     integer,
  blurhash   text,
  caption    text   not null default '',
  boards     text[] not null default '{}'::text[]
);

-- ---------------------------------------------------------------------------
-- profiles — kind 0. A "tag" is the writer's chosen name, not a hashtag.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  pubkey        text primary key,
  tag_name      text,
  city          text,
  avatar_sha256 text,
  first_seen    bigint not null,
  updated_at    bigint not null
);

-- ---------------------------------------------------------------------------
-- comments — kind 1111 (NIP-22). root_id anchors the thread, parent_id the
-- item being replied to.
-- ---------------------------------------------------------------------------
create table if not exists comments (
  event_id   text primary key references events (id) on delete cascade,
  parent_id  text,
  root_id    text,
  pubkey     text   not null,
  created_at bigint not null,
  content    text   not null default ''
);

-- ---------------------------------------------------------------------------
-- reports — kind 1984, user-facing copy "flag it".
-- ---------------------------------------------------------------------------
create table if not exists reports (
  event_id      text primary key references events (id) on delete cascade,
  reporter      text   not null,
  target_pubkey text,
  target_event  text,
  reason        text,
  note          text   not null default '',
  created_at    bigint not null
);

-- ---------------------------------------------------------------------------
-- deletions — kind 5, user-facing copy "buff". `targets` are the event ids
-- the author asked to remove; the indexer hard-deletes the ones they signed.
-- ---------------------------------------------------------------------------
create table if not exists deletions (
  event_id   text primary key references events (id) on delete cascade,
  pubkey     text   not null,
  targets    text[] not null default '{}'::text[],
  created_at bigint not null
);

-- ---------------------------------------------------------------------------
-- boards — city boards and other registries. Seeded from the kind-30078
-- registry signed by the site key, and auto-discovered from flick `t` tags.
-- ---------------------------------------------------------------------------
create table if not exists boards (
  slug       text primary key,
  title      text   not null,
  kind       text   not null default 'city',
  created_by text,
  created_at bigint not null
);

-- ---------------------------------------------------------------------------
-- pubkey_stats — cheap reputation signals for the write policy and mod queue.
-- Maintained by upserts in the indexer, not by triggers, so the logic is unit
-- testable without a live database.
-- ---------------------------------------------------------------------------
create table if not exists pubkey_stats (
  pubkey         text primary key,
  first_event_at bigint  not null,
  event_count    integer not null default 0,
  report_count   integer not null default 0
);

-- ---------------------------------------------------------------------------
-- banned_pubkeys — operator state, NOT derived from the relay. `rebuild`
-- deliberately does not truncate this table.
-- ---------------------------------------------------------------------------
create table if not exists banned_pubkeys (
  pubkey    text primary key,
  reason    text,
  banned_at bigint not null default extract(epoch from now())::bigint,
  banned_by text
);

-- ---------------------------------------------------------------------------
-- sync_state — the firehose watermark. One row, id = 'relay'.
-- ---------------------------------------------------------------------------
create table if not exists sync_state (
  id              text primary key,
  last_created_at bigint      not null default 0,
  updated_at      timestamptz not null default now()
);

insert into sync_state (id, last_created_at)
values ('relay', 0)
on conflict (id) do nothing;
