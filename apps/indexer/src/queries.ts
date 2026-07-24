import type {
  BoardRow,
  CommentRow,
  DeletionRow,
  EventRow,
  FlickRow,
  ProfileRow,
  ReportRow,
} from './mappers.js';
import type { Sql } from './types.js';

/**
 * Pure SQL builders. Every statement the indexer runs is produced here as
 * `{ text, params }` so it can be asserted in a unit test without a database.
 * No string interpolation of values — ever. Only bind parameters.
 */
export type { Sql };

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export function upsertEvent(row: EventRow): Sql {
  return {
    text: `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           on conflict (id) do nothing`,
    params: [
      row.id,
      row.pubkey,
      row.kind,
      row.created_at,
      row.content,
      row.tags,
      row.raw,
      row.expires_at,
    ],
  };
}

// ---------------------------------------------------------------------------
// derived tables
// ---------------------------------------------------------------------------

export function upsertProfile(row: ProfileRow): Sql {
  return {
    text: `insert into profiles (pubkey, tag_name, city, avatar_sha256, first_seen, updated_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (pubkey) do update set
             tag_name      = excluded.tag_name,
             city          = excluded.city,
             avatar_sha256 = excluded.avatar_sha256,
             first_seen    = least(profiles.first_seen, excluded.first_seen),
             updated_at    = excluded.updated_at
           where excluded.updated_at >= profiles.updated_at`,
    params: [row.pubkey, row.tag_name, row.city, row.avatar_sha256, row.first_seen, row.updated_at],
  };
}

export function upsertFlick(row: FlickRow): Sql {
  return {
    text: `insert into flicks (event_id, pubkey, created_at, url, sha256, width, height, blurhash, caption, boards)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[])
           on conflict (event_id) do update set
             url      = excluded.url,
             sha256   = excluded.sha256,
             width    = excluded.width,
             height   = excluded.height,
             blurhash = excluded.blurhash,
             caption  = excluded.caption,
             boards   = excluded.boards`,
    params: [
      row.event_id,
      row.pubkey,
      row.created_at,
      row.url,
      row.sha256,
      row.width,
      row.height,
      row.blurhash,
      row.caption,
      row.boards,
    ],
  };
}

export function upsertComment(row: CommentRow): Sql {
  return {
    text: `insert into comments (event_id, parent_id, root_id, pubkey, created_at, content)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (event_id) do update set
             parent_id = excluded.parent_id,
             root_id   = excluded.root_id,
             content   = excluded.content`,
    params: [row.event_id, row.parent_id, row.root_id, row.pubkey, row.created_at, row.content],
  };
}

export function upsertReport(row: ReportRow): Sql {
  return {
    text: `insert into reports (event_id, reporter, target_pubkey, target_event, reason, note, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (event_id) do nothing`,
    params: [
      row.event_id,
      row.reporter,
      row.target_pubkey,
      row.target_event,
      row.reason,
      row.note,
      row.created_at,
    ],
  };
}

export function upsertDeletion(row: DeletionRow): Sql {
  return {
    text: `insert into deletions (event_id, pubkey, targets, created_at)
           values ($1, $2, $3::text[], $4)
           on conflict (event_id) do nothing`,
    params: [row.event_id, row.pubkey, row.targets, row.created_at],
  };
}

/**
 * `registry` rows come from the site-key-signed kind 30078 event and win.
 * `discovered` rows are inferred from a flick's `t` tags and never overwrite
 * a real title.
 */
export function upsertBoard(row: BoardRow, source: 'registry' | 'discovered'): Sql {
  const conflict =
    source === 'registry'
      ? `do update set title = excluded.title,
                       kind = excluded.kind,
                       created_by = coalesce(excluded.created_by, boards.created_by),
                       created_at = least(boards.created_at, excluded.created_at)`
      : `do update set created_at = least(boards.created_at, excluded.created_at)`;

  return {
    text: `insert into boards (slug, title, kind, created_by, created_at)
           values ($1, $2, $3, $4, $5)
           on conflict (slug) ${conflict}`,
    params: [row.slug, row.title, row.kind, row.created_by, row.created_at],
  };
}

// ---------------------------------------------------------------------------
// pubkey_stats
// ---------------------------------------------------------------------------

/** Called once per event actually inserted (not once per event received). */
export function touchPubkeyStats(pubkey: string, createdAt: number): Sql {
  return {
    text: `insert into pubkey_stats (pubkey, first_event_at, event_count, report_count)
           values ($1, $2, 1, 0)
           on conflict (pubkey) do update set
             first_event_at = least(pubkey_stats.first_event_at, excluded.first_event_at),
             event_count    = pubkey_stats.event_count + 1`,
    params: [pubkey, createdAt],
  };
}

/** Bumps the *reported* writer's counter, not the reporter's. */
export function incrementReportCount(targetPubkey: string, createdAt: number): Sql {
  return {
    text: `insert into pubkey_stats (pubkey, first_event_at, event_count, report_count)
           values ($1, $2, 0, 1)
           on conflict (pubkey) do update set
             first_event_at = least(pubkey_stats.first_event_at, excluded.first_event_at),
             report_count   = pubkey_stats.report_count + 1`,
    params: [targetPubkey, createdAt],
  };
}

// ---------------------------------------------------------------------------
// buff (kind 5)
// ---------------------------------------------------------------------------

export interface BuffPlan {
  /** The signer of the kind-5 event. Only their own rows may be removed. */
  pubkey: string;
  /** Well-formed event ids named by the request. */
  targets: string[];
  /** Ids that were named but rejected as malformed. Counted, never logged. */
  rejected: number;
}

/**
 * The buff rule, in one place: a writer may delete their own events and
 * nobody else's. Ownership is enforced in SQL (`pubkey = $2`) rather than by
 * a read-then-write, so a forged deletion cannot race a legitimate one.
 */
export function buffPlan(deletion: Pick<DeletionRow, 'pubkey' | 'targets'>): BuffPlan {
  const targets: string[] = [];
  let rejected = 0;
  for (const id of new Set(deletion.targets)) {
    if (HEX64.test(id)) targets.push(id);
    else rejected += 1;
  }
  return { pubkey: deletion.pubkey, targets, rejected };
}

/**
 * Hard-delete. `flicks`, `comments`, `reports` and `deletions` all reference
 * `events(id) on delete cascade`, so removing the event row removes every
 * derived row with it.
 */
export function buffDelete(plan: BuffPlan): Sql {
  return {
    text: `delete from events where id = any($1::text[]) and pubkey = $2`,
    params: [plan.targets, plan.pubkey],
  };
}

// ---------------------------------------------------------------------------
// NIP-40 sweep
// ---------------------------------------------------------------------------

/**
 * The periodic expiration sweep. Runs every `SWEEP_INTERVAL_MS` (60s default).
 * Rows whose expiry has passed are gone from the index even if the relay has
 * not got round to purging them yet.
 */
export function expirationSweep(nowSeconds: number): Sql {
  return {
    text: `delete from events where expires_at is not null and expires_at <= $1`,
    params: [nowSeconds],
  };
}

// ---------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------

export const SYNC_STATE_ID = 'relay';

export function readWatermark(): Sql {
  return {
    text: `select last_created_at from sync_state where id = $1`,
    params: [SYNC_STATE_ID],
  };
}

/** Monotonic: a late out-of-order event never rewinds the stored watermark. */
export function writeWatermark(createdAt: number): Sql {
  return {
    text: `insert into sync_state (id, last_created_at, updated_at)
           values ($1, $2, now())
           on conflict (id) do update set
             last_created_at = greatest(sync_state.last_created_at, excluded.last_created_at),
             updated_at      = now()`,
    params: [SYNC_STATE_ID, createdAt],
  };
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

/**
 * Everything derived from the relay. `banned_pubkeys` is intentionally absent:
 * it is operator state, and a rebuild must not unban anyone.
 */
export const DERIVED_TABLES = [
  'events',
  'flicks',
  'profiles',
  'comments',
  'reports',
  'deletions',
  'boards',
  'pubkey_stats',
  'sync_state',
] as const;

export function truncateDerived(): Sql {
  return {
    text: `truncate table ${DERIVED_TABLES.join(', ')} restart identity cascade`,
    params: [],
  };
}
