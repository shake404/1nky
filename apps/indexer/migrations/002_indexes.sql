-- 002_indexes.sql — read paths for the API.

-- Full-text search over event content (GET /search).
create index if not exists events_content_tsv_gin on events using gin (content_tsv);

-- The feed and per-kind scans.
create index if not exists events_kind_created_at_idx on events (kind, created_at desc);
create index if not exists events_pubkey_created_at_idx on events (pubkey, created_at desc);

-- The 60s NIP-40 sweep only ever looks at rows that can expire.
create index if not exists events_expires_at_idx on events (expires_at) where expires_at is not null;

-- Board filtering: `boards && array['sf']`.
create index if not exists flicks_boards_gin on flicks using gin (boards);

-- Keyset pagination key for GET /feed. Matches the ORDER BY exactly.
create index if not exists flicks_keyset_idx on flicks (created_at desc, event_id desc);

-- GET /writer/:pubkey
create index if not exists flicks_pubkey_created_at_idx on flicks (pubkey, created_at desc);

-- Threading and reply counts.
create index if not exists comments_root_created_at_idx on comments (root_id, created_at);
create index if not exists comments_parent_idx on comments (parent_id);

-- Mod queue ordering and target lookups.
create index if not exists reports_created_at_idx on reports (created_at desc);
create index if not exists reports_target_event_idx on reports (target_event);
create index if not exists reports_target_pubkey_idx on reports (target_pubkey);

-- Buff enforcement: "was this event ever named as a deletion target?"
create index if not exists deletions_targets_gin on deletions using gin (targets);
create index if not exists deletions_pubkey_idx on deletions (pubkey);
