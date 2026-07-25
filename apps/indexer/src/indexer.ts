import { ALL_KINDS, KINDS, type SignedEvent } from '@1nky/protocol';

import { exportBanListSafe } from './banlist-export.js';
import { backoffDelay, type IndexerConfig } from './config.js';
import { exportInvitedListSafe } from './invited-export.js';
import * as log from './log.js';
import { type RelayClientOptions, runConnection } from './relay.js';
import {
  type Counters,
  indexEvent,
  newCounters,
  readWatermark,
  sweepExpired,
  writeWatermark,
} from './store.js';
import type { Queryable } from './types.js';

/**
 * Everything 1NKY indexes.
 *
 * Two kinds are excluded, for different reasons:
 *
 *   24242 — Blossom upload authorisations. Request credentials for the media
 *           service, not content. Never stored.
 *
 *    1059 — NIP-59 gift wraps: private messages. THIS EXCLUSION IS A PRIVACY
 *           GUARANTEE, NOT AN OPTIMISATION. Postgres is served to the world
 *           through the read-only REST API, and `events` is queried by kind,
 *           by pubkey and by full-text search. Copying wraps in would publish
 *           the shape of every private conversation on the site — who was
 *           messaged, how often, when, how much — to anyone who can call the
 *           API, even though the bodies stay encrypted. Wraps live in the
 *           relay only, where a client fetches its own with a `#p` filter and
 *           nothing is queryable by anyone else. Do not "just index the
 *           metadata"; the metadata is the leak.
 *
 * The filter below keeps them out of the firehose subscription. `indexEvent`
 * refuses 1059 a second time, so a rebuild, a wider filter or a hand-fed
 * event cannot get one into the database by another route.
 */
export const INDEXED_KINDS: readonly number[] = ALL_KINDS.filter(
  (kind) => kind !== KINDS.BLOSSOM_AUTH && kind !== KINDS.GIFT_WRAP,
);

/** Persist the watermark at most this often, in events. */
const WATERMARK_EVERY = 50;

export interface RunOptions {
  db: Queryable;
  config: IndexerConfig;
  sitePubkey?: string | undefined;
  /** Stop after the relay's stored events have been replayed (rebuild mode). */
  once?: boolean;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createSocket?: RelayClientOptions['createSocket'];
  /** Give up after this many connection attempts. Tests only. */
  maxAttempts?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The firehose loop.
 *
 * Reconnects with jittered exponential backoff forever (or until `once`
 * completes). The only output is a periodic count line on stderr.
 */
export async function run(options: RunOptions): Promise<Counters> {
  const { db, config } = options;
  const nowSeconds = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const sleep = options.sleep ?? defaultSleep;

  const counters = newCounters();
  let watermark = await readWatermark(db);
  let pending = 0;
  let attempt = 0;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Re-export the strfry ban list whenever a mod action changed it. Swallows
  // filesystem failures by design: a missing bind mount or a full disk must not
  // stop the firehose. No-ops when BAN_LIST_EXPORT_PATH is unset.
  const onBanChange = async (): Promise<void> => {
    await exportBanListSafe(db, config.banListExportPath);
  };

  // Same contract for the invited list: a redemption lands, the relay learns
  // within ~1s that this writer no longer owes the newcomer PoW tier. A failed
  // export costs them a slower next post, never an indexing stall. No-ops when
  // INVITED_LIST_EXPORT_PATH is unset.
  const onInvitedChange = async (): Promise<void> => {
    await exportInvitedListSafe(db, config.invitedListExportPath);
  };

  const onEvent = async (event: SignedEvent): Promise<void> => {
    try {
      await indexEvent(db, event, counters, {
        now: nowSeconds(),
        sitePubkey: options.sitePubkey,
        modPubkeys: config.modPubkeys,
        onBanChange,
        onInvitedChange,
      });
    } catch (err) {
      counters.errors += 1;
      // Kind is safe to name (hard rule #1 permits event ids and kinds).
      log.error(`index kind=${event.kind}`, err);
      return;
    }
    if (event.created_at > watermark) watermark = event.created_at;
    pending += 1;
    if (pending >= WATERMARK_EVERY) {
      pending = 0;
      await writeWatermark(db, watermark).catch((err: unknown) => {
        counters.errors += 1;
        log.error('watermark', err);
      });
    }
  };

  const flush = async (): Promise<void> => {
    pending = 0;
    try {
      await writeWatermark(db, watermark);
    } catch (err) {
      counters.errors += 1;
      log.error('watermark', err);
    }
    log.counts('indexed', { ...counters });
  };

  let attempts = 0;
  while (!stopped) {
    attempts += 1;
    const since = Math.max(0, watermark - config.watermarkOverlapSeconds);
    const opened = await runConnection({
      url: config.relayWsUrl,
      filter: { kinds: INDEXED_KINDS, since },
      onEvent,
      onEose: flush,
      onInvalid: () => {
        counters.invalid += 1;
      },
      onSocketError: (err) => log.error('relay', err),
      stopAfterEose: options.once === true,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    });

    if (opened) counters.connections += 1;
    await flush();
    if (options.once === true && opened) break;
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) break;

    attempt = opened ? 0 : attempt + 1;
    if (stopped) break;
    await sleep(backoffDelay(attempt, config.backoffInitialMs, config.backoffMaxMs));
    log.state('reconnecting');
  }

  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  return counters;
}

/**
 * Starts the NIP-40 sweep. Returns a stop function. Expired rows go even if
 * the relay has not purged them yet — the index must never serve a beef
 * thread that has run out.
 */
export function startExpirationSweep(
  db: Queryable,
  intervalMs: number,
  now: () => number = () => Math.floor(Date.now() / 1000),
): () => void {
  const timer = setInterval(() => {
    void sweepExpired(db, now())
      .then((removed) => {
        if (removed > 0) log.counts('swept', { expired: removed });
      })
      .catch((err: unknown) => log.error('sweep', err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
