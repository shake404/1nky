import type { SignedEvent } from '@1nky/protocol';

import type { Queryable, Sql } from './types.js';
import {
  boardRowsFromFlick,
  boardRowsFromRegistry,
  isExpired,
  routeOf,
  toCommentRow,
  toDeletionRow,
  toEventRow,
  toFlickRow,
  toProfileRow,
  toReportRow,
} from './mappers.js';
import * as q from './queries.js';

/** Everything the indexer is allowed to say out loud: counts. */
export interface Counters {
  events: number;
  profiles: number;
  flicks: number;
  comments: number;
  reports: number;
  deletions: number;
  boards: number;
  buffed: number;
  duplicates: number;
  expired: number;
  invalid: number;
  errors: number;
  /** Successful relay connections. Zero after a run means the relay is down. */
  connections: number;
}

export function newCounters(): Counters {
  return {
    events: 0,
    profiles: 0,
    flicks: 0,
    comments: 0,
    reports: 0,
    deletions: 0,
    boards: 0,
    buffed: 0,
    duplicates: 0,
    expired: 0,
    invalid: 0,
    errors: 0,
    connections: 0,
  };
}

async function run(db: Queryable, sql: Sql): Promise<number> {
  const result = await db.query(sql.text, sql.params);
  return result.rowCount ?? 0;
}

export interface IndexOptions {
  /** Current unix seconds, injected so expiry is testable. */
  now: number;
  /**
   * When set, only this pubkey's kind-30078 events may define boards. Unset
   * (local dev) means any signer can, which is fine because nothing but the
   * board list depends on it.
   */
  sitePubkey?: string | undefined;
}

/**
 * Applies one verified event to the index.
 *
 * The caller has already checked the signature. This function is responsible
 * for expiry, routing by kind, and keeping `pubkey_stats` honest.
 */
export async function indexEvent(
  db: Queryable,
  event: SignedEvent,
  counters: Counters,
  options: IndexOptions,
): Promise<void> {
  if (isExpired(event, options.now)) {
    counters.expired += 1;
    return;
  }

  const inserted = await run(db, q.upsertEvent(toEventRow(event)));
  if (inserted === 0) {
    counters.duplicates += 1;
    return;
  }
  counters.events += 1;
  await run(db, q.touchPubkeyStats(event.pubkey, event.created_at));

  switch (routeOf(event.kind)) {
    case 'profile': {
      await run(db, q.upsertProfile(toProfileRow(event)));
      counters.profiles += 1;
      return;
    }

    case 'flick': {
      const flick = toFlickRow(event);
      if (!flick) {
        counters.invalid += 1;
        return;
      }
      await run(db, q.upsertFlick(flick));
      counters.flicks += 1;
      for (const board of boardRowsFromFlick(event)) {
        await run(db, q.upsertBoard(board, 'discovered'));
      }
      return;
    }

    case 'comment': {
      const comment = toCommentRow(event);
      if (!comment) {
        counters.invalid += 1;
        return;
      }
      await run(db, q.upsertComment(comment));
      counters.comments += 1;
      return;
    }

    case 'report': {
      const report = toReportRow(event);
      if (!report) {
        counters.invalid += 1;
        return;
      }
      await run(db, q.upsertReport(report));
      counters.reports += 1;
      if (report.target_pubkey) {
        await run(db, q.incrementReportCount(report.target_pubkey, event.created_at));
      }
      return;
    }

    case 'deletion': {
      const deletion = toDeletionRow(event);
      if (!deletion) {
        counters.invalid += 1;
        return;
      }
      await run(db, q.upsertDeletion(deletion));
      counters.deletions += 1;

      // "Buff": hard-delete the named events, but only the signer's own.
      const plan = q.buffPlan(deletion);
      if (plan.targets.length > 0) {
        counters.buffed += await run(db, q.buffDelete(plan));
      }
      return;
    }

    case 'registry': {
      if (options.sitePubkey && event.pubkey !== options.sitePubkey) return;
      for (const board of boardRowsFromRegistry(event)) {
        await run(db, q.upsertBoard(board, 'registry'));
        counters.boards += 1;
      }
      return;
    }

    default:
      // Stored in `events` only (kind 1 thread OPs, kind 10000 mute lists).
      return;
  }
}

/** Deletes every row whose NIP-40 expiry has passed. Returns rows removed. */
export async function sweepExpired(db: Queryable, now: number): Promise<number> {
  return run(db, q.expirationSweep(now));
}

/** Highest `created_at` the indexer has durably stored. */
export async function readWatermark(db: Queryable): Promise<number> {
  const sql = q.readWatermark();
  const { rows } = await db.query<{ last_created_at: string | number }>(sql.text, sql.params);
  const value = rows[0]?.last_created_at;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function writeWatermark(db: Queryable, createdAt: number): Promise<void> {
  await run(db, q.writeWatermark(createdAt));
}

/** Wipes everything derived from the relay. Leaves `banned_pubkeys` alone. */
export async function truncateDerived(db: Queryable): Promise<void> {
  await run(db, q.truncateDerived());
}
