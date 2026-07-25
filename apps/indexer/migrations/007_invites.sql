-- 007_invites.sql — invite trees ("getting put on").
--
-- Forward-only, like every migration here: 001-006 are applied and never
-- edited. Everything in this file is a brand-new table plus its indexes, so an
-- existing index gains it without a rewrite; `pnpm --filter @1nky/indexer
-- rebuild` replays the relay into it.
--
-- THE MODEL. An existing writer mints an invite — a kind-30078 event keyed
-- `d = "invite:<id>"`, signed by them. Whoever they hand the code to redeems it
-- by putting one `['invite', <id>, <inviter>]` tag on their own kind-0 profile.
-- Two signed events, no server in the middle, and a chain of custody anybody
-- can reconstruct from the relay alone.
--
-- BOTH TABLES ARE DERIVED. They are in DERIVED_TABLES (src/queries.ts) and a
-- rebuild truncates and replays them, exactly like `flicks` or `threads`. That
-- is deliberate and it is what makes the invite forest trustworthy: it is not
-- operator state anybody can hand-edit, it is a projection of signed events.
-- (`banned_pubkeys` is the one table that is NOT derived — a rebuild must never
-- unban anyone — which is why a subtree ban writes there and not here.)
--
-- No client-identifying data: an invite and its redemption are both published,
-- signed events. See 001_init.sql and src/schema.test.ts for the cardinal rule.

-- ---------------------------------------------------------------------------
-- invites — one row per minted invite. First mint wins: a second kind-30078
-- claiming an id already in this table does nothing, so an inviter cannot
-- retroactively steal an id somebody else already published.
-- ---------------------------------------------------------------------------
create table if not exists invites (
  invite_id   text primary key,
  -- Who minted it (the event's own pubkey). Never a name, never a code.
  inviter     text   not null,
  created_at  bigint not null,
  -- Set once, when a kind-0 redeems it. Null means the invite is still open.
  redeemed_by text,
  redeemed_at bigint
);

-- "Show me the invites this writer minted" — the mod tree view and a writer's
-- own list of outstanding codes.
create index if not exists invites_inviter_idx on invites (inviter);

-- Open invites, for a count of how many codes are still out there.
create index if not exists invites_open_idx on invites (inviter) where redeemed_by is null;

-- ---------------------------------------------------------------------------
-- invite_edges — the forest itself: one row per writer who was put on.
--
-- `child` is the PRIMARY KEY, and that single constraint is the whole social
-- rule: ONE PARENT, FOREVER. The first redemption a writer lands is the one
-- that sticks; every later attempt conflicts and is silently dropped. Nobody
-- gets to re-parent themselves onto a cleaner branch after their inviter is
-- banned, which is exactly what makes a subtree ban meaningful.
--
-- No foreign key to `invites`: the redemption path already proves the invite
-- exists (in SQL, in the same statement that marks it redeemed), and leaving
-- the two tables independent means either can be rebuilt without ordering
-- constraints on the firehose.
-- ---------------------------------------------------------------------------
create table if not exists invite_edges (
  child       text primary key,
  parent      text   not null,
  invite_id   text   not null,
  redeemed_at bigint not null
);

-- Walking down the tree: the recursive CTE behind `GET /mod/tree` and behind a
-- subtree ban joins on `parent` at every level, so this index is what keeps
-- both from degrading into a full scan per level.
create index if not exists invite_edges_parent_idx on invite_edges (parent);

-- Walking UP is free: `child` is the primary key, so "who put this writer on?"
-- and the invited-list export's ordered scan of every child both ride the
-- primary key index and need nothing added here.
