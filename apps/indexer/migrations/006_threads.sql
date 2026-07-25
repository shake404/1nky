-- 006_threads.sql — city-board threads ("beef" when they expire).
--
-- Forward-only, like every migration here: 001-005 are applied and never
-- edited. Everything in this file is a brand-new table plus its indexes, so an
-- existing index gains it without a rewrite; `pnpm --filter @1nky/indexer
-- rebuild` replays the relay into it.
--
-- A thread OP is a kind-1 note with an optional `['subject', ...]` tag and its
-- board `['t', ...]` tags. Until now it landed in `events` only, so a board
-- could not list its threads without a jsonb tag scan. This table is the same
-- kind of denormalisation `flicks` and `videos` are: DERIVED, truncatable, and
-- rebuilt from the relay.
--
-- Deliberately absent:
--   * `content` — it stays in `events`, which every thread read already joins
--     for `expires_at` (NIP-40). One copy, no drift.
--   * `expires_at` — same reason. The relay purges an expired event and the
--     60s sweep deletes the `events` row, which cascades to here.
--
-- No client-identifying data: a thread row is a signed, published event
-- denormalised for the board reads. See 001_init.sql and src/schema.test.ts
-- for the cardinal rule.

create table if not exists threads (
  event_id   text primary key references events (id) on delete cascade,
  pubkey     text   not null,
  -- The thread title. Null is legitimate: a bare kind 1 with no subject tag is
  -- still a thread OP on this platform, it just shows its first line instead.
  subject    text,
  boards     text[] not null default '{}'::text[],
  created_at bigint not null
);

-- Board filtering (`boards && array['sf']`), mirroring flicks_boards_gin.
create index if not exists threads_boards_gin on threads using gin (boards);

-- GET /board/:slug ordering and its keyset page bound. Matches the ORDER BY
-- of the newest-activity sort as closely as an index can: the outer sort key
-- is `greatest(created_at, last_reply_at)`, which starts from created_at.
create index if not exists threads_created_at_idx on threads (created_at desc);
create index if not exists threads_keyset_idx on threads (created_at desc, event_id desc);

-- A writer's own threads.
create index if not exists threads_pubkey_created_at_idx on threads (pubkey, created_at desc);
