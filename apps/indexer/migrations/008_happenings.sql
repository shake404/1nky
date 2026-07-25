-- 008_happenings.sql — happenings: a thread with a date on it.
--
-- Forward-only, like every migration here: 001-007 are applied and never
-- edited. This file adds ONE nullable column to `threads` plus a partial index,
-- so an existing index gains it without a table rewrite and without a default
-- backfill; `pnpm --filter @1nky/indexer rebuild` replays the relay into it.
--
-- THE MODEL. A happening is not a new kind and not a new table. It is a kind-1
-- thread OP carrying two extra tags: a plain `['t','happening']` board marker
-- (so every board read, every reply path and the NIP-40 sweep already work on
-- it) and a `['when','<unix seconds>']` date. `@1nky/protocol`'s
-- `buildThreadOp({ happeningAt })` emits both, plus an `expiration` of
-- happeningAt + 7 days, so a happening removes itself a week after it happens
-- with no cleanup job of its own.
--
-- FULLY DERIVED. `happening_at` is read straight off the event's `when` tag by
-- `toThreadRow` (src/mappers.ts), so a rebuild reproduces it exactly. There is
-- nothing operator-set here and nothing to migrate: rows that predate this
-- column stay null, which is the true answer — they carried no `when` tag.
--
-- Deliberately absent: any second copy of the expiry. `events.expires_at`
-- remains the one NIP-40 column, and the API's 7-day "is this still upcoming"
-- window is computed from `happening_at` at read time rather than stored.
--
-- No client-identifying data: a happening is a signed, published event
-- denormalised for the board reads. See 001_init.sql and src/schema.test.ts
-- for the cardinal rule.

-- When the thing actually happens (unix seconds). Null for every ordinary
-- thread, which is almost all of them — hence a nullable column and a PARTIAL
-- index rather than a new table: the happenings read is a small, sparse slice
-- of `threads` and the index only has to cover that slice.
alter table threads add column if not exists happening_at bigint;

-- GET /happenings orders `happening_at asc` (soonest first) and filters
-- `happening_at is not null`, so the index carries exactly those rows.
create index if not exists threads_happening_at_idx
  on threads (happening_at)
  where happening_at is not null;
