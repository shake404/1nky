-- 009_mentions.sql — "somebody said your name": deliberate @-mentions.
--
-- Forward-only, like every migration here: 001-008 are applied and never
-- edited. This file adds ONE new table plus its read index, so an existing
-- index gains it without a rewrite; `pnpm --filter @1nky/indexer rebuild`
-- replays the relay into it.
--
-- THE MODEL. A comment (kind 1111) already carries `p` tags nobody typed: the
-- parent author and the thread root's author, which is how NIP-22 addresses a
-- reply. An inbox keyed on `p` alone would therefore be a second copy of the
-- reply feed. So `@1nky/protocol` marks a *deliberate* mention in position 3 of
-- the tag — `['p', <pubkey>, '', 'mention']`, the same slot NIP-10 puts a marker
-- in — and `isMentionTag` is the one place that convention is spelled out.
-- Reply targets stay unmarked. Only the marked ones land in this table.
--
-- FULLY DERIVED. Every column is read straight off the signed event by
-- `mentionRowsFromEvent` (src/mappers.ts) — no clock, no operator state — so a
-- rebuild reproduces the table exactly. It is in DERIVED_TABLES and truncates
-- with the rest.
--
-- Forward-only in the data sense too: an event published before the marker
-- existed has no marker and produces no row. That is acceptable and deliberate
-- — @-mentions themselves only just shipped, so the events without a marker are
-- the ones from before a mention could be typed at all. Nothing is backfilled
-- and nothing guesses.
--
-- Deliberately absent:
--   * the comment's text — it stays in `comments`/`events`, which the inbox read
--     joins anyway. One copy, no drift, and a buffed comment takes its mention
--     with it through the `events` cascade.
--   * any read/seen state. Who has looked at their own inbox is the device's
--     business (the client keeps a last-seen stamp locally); there is no
--     account concept server-side and this table must not become one.
--
-- No client-identifying data: a mention is a tag on a signed, published event
-- denormalised for one read. See 001_init.sql and src/schema.test.ts for the
-- cardinal rule.

create table if not exists mentions (
  -- The comment that did the naming. Cascades: buff the comment (or let it
  -- expire) and the mention goes with it, which is what "it never happened"
  -- has to mean.
  event_id         text   not null references events (id) on delete cascade,
  -- The writer who was named. This is the inbox key.
  mentioned_pubkey text   not null,
  -- Who named them. Denormalised off `comments.pubkey` so the inbox read can
  -- drop an ignored/banned writer without a second join for the common case.
  author_pubkey    text   not null,
  -- The flick or thread the conversation hangs off, for the deep link. Null
  -- only for a comment that anchors nowhere, which `toCommentRow` already
  -- refuses to store.
  root_id          text,
  created_at       bigint not null,
  -- One row per (comment, named writer). A re-delivered event cannot double up,
  -- and naming somebody twice in one comment is still one mention.
  primary key (event_id, mentioned_pubkey)
);

-- The whole point of the table: GET /mentions/:pubkey, newest first, keyset
-- paged on `(created_at, event_id) desc` exactly like every other paged read.
create index if not exists mentions_inbox_idx
  on mentions (mentioned_pubkey, created_at desc, event_id desc);
