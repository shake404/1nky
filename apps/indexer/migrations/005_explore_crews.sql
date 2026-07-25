-- 005_explore_crews.sql — Explore facets and crews.
--
-- Forward-only, like every migration here: 001-004 are applied and never
-- edited. Everything in this file is additive (nullable columns or
-- brand-new tables), so an existing index gains it without a rewrite and
-- older rows simply carry null/empty until a new event fills them in.
--
-- No client-identifying data: crew definitions, badges and profile crews are
-- signed, published content the writer (or the site key) chose to put on the
-- relay. See 001_init.sql and src/schema.test.ts for the cardinal rule.

-- A city board optionally declares its parent region (explore-and-crews
-- Part 3.3). Nullable, no backfill — existing city rows stay region-less
-- until a registry entry (or an operator) assigns one.
alter table boards add column if not exists region_slug text references boards (slug);

-- Self-declared crew affiliations on a writer's kind-0 profile (Part 4.2).
-- A *claim*, not a roster — kept separate from the crew-signed definition
-- below. Mirrors the existing `city` column: parsed from kind-0 content.
alter table profiles add column if not exists crews text[] not null default '{}'::text[];

-- ---------------------------------------------------------------------------
-- crews — kind-30078 with d:crew, signed by the crew's own key.
-- One row per crew (NIP-33 parameterized-replaceable: 30078:<crew-pubkey>:crew),
-- refreshed wholesale on each new definition event. The roster rides in
-- `members` (text[]); the content JSON also carries it for content readers.
-- ---------------------------------------------------------------------------
create table if not exists crews (
  crew_pubkey    text primary key,
  name           text   not null,
  mark           text,
  founder_pubkey text,
  founded_at     bigint,
  members        text[] not null default '{}'::text[],
  created_at     bigint not null,
  updated_at     bigint not null
);

-- ---------------------------------------------------------------------------
-- crew_badges — kind-30078 d:crew-badges, signed by the SITE key only.
-- Mirrors banned_pubkeys: one row per verified crew, same
-- reload-on-new-registry-event pattern. A badge affects display (the ✓),
-- never what the relay accepts — additive display data, not write-policy.
-- ---------------------------------------------------------------------------
create table if not exists crew_badges (
  crew_pubkey  text primary key,
  verified_at  bigint not null,
  verified_by  text
);

-- Explore facet filtering rides on the boards array (city + type + surface +
-- region + legal all land in flicks.boards / videos.boards as t tags), so
-- the GIN indexes from 002 (flicks_boards_gin, videos_boards_gin) already
-- serve the array-overlap / array-containment reads. Add the same GIN for
-- the new profiles.crews "repping" lookup (`profiles.crews @> ARRAY[...]`).
create index if not exists profiles_crews_gin on profiles using gin (crews);

-- Region -> city hierarchy lookup.
create index if not exists boards_region_slug_idx on boards (region_slug) where region_slug is not null;
