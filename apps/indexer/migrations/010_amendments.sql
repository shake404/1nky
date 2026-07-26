-- 010_amendments.sql — "Add to this": tags an author adds to their own post.
--
-- Forward-only, like every migration here: 001-009 are applied and never
-- edited. This file adds ONE new table plus its lookup index, so an existing
-- index gains it without a rewrite; `pnpm --filter @1nky/indexer rebuild`
-- replays the relay into it.
--
-- THE PROBLEM. A signed event is immutable and every comment under a flick
-- references that flick's id, so a post cannot be "edited": buffing and
-- reposting to add a wall you forgot would orphan the entire conversation. So
-- the fix is additive — a kind-1113 event (see KINDS.AMENDMENT), signed by the
-- SAME author, naming the original with `e`/`k` and carrying the tags that were
-- missing: city walls as `t` tags, writers as marked mention `p` tags.
--
-- ADD-ONLY, WHICH IS WHY THIS TABLE IS SHAPED LIKE THIS. The read model is the
-- UNION of the original's tags with every amendment's. A union is commutative
-- and idempotent, which is what makes the merge converge under ANY delivery
-- order — and order really does vary: a relay hands back stored events newest
-- first, so on a rebuild an amendment routinely arrives BEFORE the thing it
-- amends. That case is why the amendment is stored here at all rather than only
-- being folded into `flicks.boards` on the way past:
--
--   * amendment arrives second (the live case): the merge is applied
--     immediately, guarded in SQL by `event_id = target and pubkey = author`
--   * amendment arrives first (the rebuild case): the row sits here until its
--     target lands, and indexing the target replays every amendment filed
--     against it (`selectPendingAmendments`)
--
-- ONLY THE AUTHOR'S OWN AMENDMENT COUNTS, and that is enforced twice, both
-- times in SQL rather than by a read-then-write: the live merge's `pubkey =
-- author` predicate, and the pending replay's `author_pubkey = <target's
-- pubkey>` filter. `author_pubkey` here is the amendment's own signer, so a
-- writer cannot file tags against somebody else's post — the row is stored (the
-- relay accepted it, and the relay is the source of truth) and is simply inert.
--
-- A BUFFED ORIGINAL STAYS BUFFED. Buffing hard-deletes the original from
-- `events`, and both the boards merge and the mention insert are conditioned on
-- the target still being there, so an amendment landing afterwards is ignored
-- rather than resurrecting anything. There is no FK on `target_id` for exactly
-- that reason (and for the arrives-first case): the target may legitimately not
-- be in `events` at all.
--
-- Deliberately absent:
--   * anything about REMOVING a tag. Add-only is the semantic (see
--     `buildAmendment`), so there is no tombstone and no "latest wins" ordering
--     to get wrong. A tag that already had consequences — a mention that landed
--     in somebody's shout-outs — cannot honestly be taken back. The escape
--     hatch for a genuinely wrong wall is the destructive one that already
--     exists: buff the post and put it up again.
--   * the amendment's content. It has none; an amendment is tags.
--
-- One known rough edge, recorded rather than hidden: buffing an AMENDMENT
-- cascades this row away but does not un-merge a slug already written into
-- `flicks.boards`. Postgres is a rebuildable cache, so the repair is the one
-- the whole design already leans on — the amendment is gone from the relay, so
-- a rebuild reproduces the merge without it.
--
-- No client-identifying data: every column is read off a signed, published
-- event. See 001_init.sql and src/schema.test.ts for the cardinal rule.

create table if not exists amendments (
  -- The amendment event itself. Cascades: buff it (or let it expire) and the
  -- record goes with it.
  event_id      text   primary key references events (id) on delete cascade,
  -- The post being added to. NOT a foreign key, on purpose — see above.
  target_id     text   not null,
  -- The amendment's signer. Compared against the target's author at merge time;
  -- an amendment from anybody else never applies.
  author_pubkey text   not null,
  -- Normalised board slugs this amendment ADDS (`normalizeBoard`, deduped).
  boards        text[] not null default '{}',
  -- Writers this amendment names, already excluding the author: naming yourself
  -- files nothing, exactly as it files nothing on a comment.
  mentions      text[] not null default '{}',
  created_at    bigint not null
);

-- The only lookup there is: "every amendment this author filed against this
-- post", run once when a target is indexed (the arrives-first replay).
create index if not exists amendments_target_idx
  on amendments (target_id, author_pubkey);
