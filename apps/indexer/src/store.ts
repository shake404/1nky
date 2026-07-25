import { KINDS, type SignedEvent } from '@1nky/protocol';

import type { Queryable, Sql } from './types.js';
import {
  boardRowsFromFlick,
  boardRowsFromRegistry,
  crewBadgeRowsFromRegistry,
  crewDefinitionRowFromEvent,
  isExpired,
  modBanActionFromEvent,
  routeOf,
  tagValue,
  toCommentRow,
  toDeletionRow,
  toEventRow,
  toFlickRow,
  toProfileRow,
  toReportRow,
  toThreadRow,
  toVideoRow,
} from './mappers.js';
import * as q from './queries.js';

/** Everything the indexer is allowed to say out loud: counts. */
export interface Counters {
  events: number;
  profiles: number;
  flicks: number;
  videos: number;
  /** Kind-1 thread OPs on city boards. */
  threads: number;
  comments: number;
  reports: number;
  deletions: number;
  boards: number;
  crews: number;
  crewBadges: number;
  /** Moderator bans applied to `banned_pubkeys`. Counts only, never who. */
  bans: number;
  /** Moderator bans lifted. */
  unbans: number;
  buffed: number;
  duplicates: number;
  expired: number;
  invalid: number;
  /** Events deliberately not stored — currently gift wraps (kind 1059). */
  skipped: number;
  errors: number;
  /** Successful relay connections. Zero after a run means the relay is down. */
  connections: number;
}

export function newCounters(): Counters {
  return {
    events: 0,
    profiles: 0,
    flicks: 0,
    videos: 0,
    threads: 0,
    comments: 0,
    reports: 0,
    deletions: 0,
    boards: 0,
    crews: 0,
    crewBadges: 0,
    bans: 0,
    unbans: 0,
    buffed: 0,
    duplicates: 0,
    expired: 0,
    invalid: 0,
    skipped: 0,
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
  /**
   * Site moderators, lowercase hex (`config.modPubkeys`). Two things depend on
   * it and nothing else does: a kind-30078 ban/unban is applied to
   * `banned_pubkeys` only from one of these signers, and a kind-5 from one of
   * these signers is a takedown that reaches another writer's events. Unset
   * (local dev) means nobody is a moderator, which is the safe default: bans
   * stay inert app data and every kind-5 is an ordinary self-buff.
   */
  modPubkeys?: ReadonlySet<string> | undefined;
  /**
   * Called after a ban or unban actually changed `banned_pubkeys`, so the
   * strfry ban list can be re-exported. It MUST NOT throw — the indexer passes
   * a wrapper that swallows filesystem failures, because a full disk is not a
   * reason to stop indexing.
   */
  onBanChange?: (() => Promise<void>) | undefined;
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
  // A gift wrap NEVER reaches Postgres — not `events`, not anywhere. This
  // database is served to the public through the read-only REST API, and a
  // wrap's plaintext envelope (recipient `p` tag, timestamp, size) is enough
  // to reconstruct who talks to whom and how much. That social graph is
  // precisely what NIP-59 exists to hide, so the index must not hold it.
  // Wraps live in the relay alone, retrieved by their recipient's own `#p`
  // filter. INDEXED_KINDS already keeps them out of the firehose; this is the
  // second lock, because `rebuild` and any future direct caller come through
  // here. Return BEFORE the first query so not one row is written.
  if (event.kind === KINDS.GIFT_WRAP) {
    counters.skipped += 1;
    return;
  }

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

    case 'thread': {
      // A thread OP always maps — a bare kind 1 with no subject and no board
      // tag is still a thread on this platform, so there is no `invalid` path
      // here. Boards are auto-registered exactly as a flick's are, so a board
      // that only has threads still shows up in GET /boards.
      await run(db, q.upsertThread(toThreadRow(event)));
      counters.threads += 1;
      for (const board of boardRowsFromFlick(event)) {
        await run(db, q.upsertBoard(board, 'discovered'));
      }
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

    case 'video': {
      const video = toVideoRow(event);
      if (!video) {
        counters.invalid += 1;
        return;
      }
      await run(db, q.upsertVideo(video));
      counters.videos += 1;
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

      // "Buff": hard-delete the named events, but only the signer's own —
      // unless the signer is a site moderator, in which case this is a takedown
      // and reaches any author's event. Everyone else's kind-5 keeps the
      // ownership predicate, so nothing about self-buffing changes.
      const isMod = options.modPubkeys?.has(event.pubkey.toLowerCase()) === true;
      const plan = q.buffPlan(deletion, isMod);
      if (plan.targets.length > 0) {
        counters.buffed += await run(db, q.buffDelete(plan));
      }
      return;
    }

    case 'registry': {
      // A moderator ban/unban rides on kind 30078 with d = "ban:<target>".
      // Checked before the `d` switch below so it can never be confused with a
      // crew definition or a board registry.
      //
      // From a pubkey that is NOT in SITE_MOD_PUBKEYS this is inert app data:
      // the raw event stays in `events` (the relay accepted it, and the relay is
      // the source of truth) and not one row of `banned_pubkeys` moves. The
      // signer is lowercased for the comparison; the configured set already is.
      const ban = modBanActionFromEvent(event);
      if (ban) {
        if (options.modPubkeys?.has(event.pubkey.toLowerCase()) !== true) return;

        // Parameterized-replaceable semantics live in the SQL guards, so an
        // out-of-order or replayed action cannot regress the applied state.
        // `changed === 0` means the guard refused it — nothing to export.
        const changed =
          ban.action === 'ban'
            ? await run(db, q.upsertBan(ban.row))
            : await run(db, q.deleteBan(ban.row.pubkey, ban.row.banned_at));
        if (changed === 0) return;

        if (ban.action === 'ban') counters.bans += 1;
        else counters.unbans += 1;
        if (options.onBanChange) await options.onBanChange();
        return;
      }

      const d = tagValue(event.tags, 'd');
      // A crew definition is signed by the crew's own key (anyone may define
      // their own crew). Membership is the crew-signed roster — the strong
      // trust list — so it is indexed from whoever holds the crew key.
      if (d === 'crew') {
        const crew = crewDefinitionRowFromEvent(event);
        if (crew) {
          await run(db, q.upsertCrew(crew));
          counters.crews += 1;
        }
        return;
      }
      // A crew badge attestation is signed by the SITE key only — the same
      // key that signs board registries and mod lists. A badge affects
      // display, never what the relay accepts.
      if (d === 'crew-badges') {
        if (options.sitePubkey && event.pubkey !== options.sitePubkey) return;
        for (const badge of crewBadgeRowsFromRegistry(event)) {
          await run(db, q.upsertCrewBadge(badge));
          counters.crewBadges += 1;
        }
        return;
      }
      // Board registry (d starts with "boards"), site-key signed.
      if (options.sitePubkey && event.pubkey !== options.sitePubkey) return;
      for (const board of boardRowsFromRegistry(event)) {
        await run(db, q.upsertBoard(board, 'registry'));
        counters.boards += 1;
      }
      return;
    }

    default:
      // Stored in `events` only (kind 10000 mute lists).
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
