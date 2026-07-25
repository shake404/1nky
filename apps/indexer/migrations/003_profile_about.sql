-- 003_profile_about.sql — the writer's bio.
--
-- Forward-only, like every migration here: 001 and 002 have been applied and
-- are never edited. The column is nullable with no default, so an existing
-- profiles table gains it without a rewrite and older rows simply have no bio
-- until their author republishes their kind 0.
--
-- The column is named `about` to match the field name in the kind-0 JSON
-- content, which is what the rest of the Nostr ecosystem reads and writes.
-- `@1nky/protocol`'s buildProfile calls it `bio` on the way in, because that
-- is the word a human would use, and serialises it as `about`.
--
-- No client-identifying data here: this is free text the writer chose to sign
-- and publish. See 001_init.sql and src/schema.test.ts for the cardinal rule.

alter table profiles add column if not exists about text;
