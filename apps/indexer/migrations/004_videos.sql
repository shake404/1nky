-- 004_videos.sql — kind 22 short-form video clips (NIP-71).
--
-- Forward-only, like every migration here: 001-003 have been applied and are
-- never edited. A separate `videos` table mirrors `flicks` rather than adding
-- a media_type discriminator to `flicks`, so each derived table stays
-- one-kind-one-shape and the existing flick read paths are untouched.
--
-- The feed (apps/api) UNIONes `flicks` and `videos` into one ordered stream,
-- tagging each row with its media_type so the client renders an <img> or a
-- <video>. Keyset pagination keys are identical to flicks.
--
-- No client-identifying data here: a video row is a signed, published event
-- denormalised for the feed. See 001_init.sql and src/schema.test.ts for the
-- cardinal rule.

create table if not exists videos (
  event_id   text primary key references events (id) on delete cascade,
  pubkey     text   not null,
  created_at bigint not null,
  url        text   not null,
  sha256     text   not null,
  poster_url text,
  duration   integer,
  width      integer,
  height     integer,
  blurhash   text,
  caption    text   not null default '',
  boards     text[] not null default '{}'::text[]
);

-- Board filtering, mirroring flicks_boards_gin.
create index if not exists videos_boards_gin on videos using gin (boards);

-- Keyset pagination key for the unified feed. Matches the ORDER BY exactly.
create index if not exists videos_keyset_idx on videos (created_at desc, event_id desc);

-- GET /writer/:pubkey (videos alongside flicks, when wired up).
create index if not exists videos_pubkey_created_at_idx on videos (pubkey, created_at desc);
