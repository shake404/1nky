import { ALL_KINDS, KINDS, type SignedEvent } from '@1nky/protocol';

import { backoffDelay, type IndexerConfig } from './config.js';
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
 * Everything 1NKY indexes. Blossom upload authorisations (kind 24242) are
 * request credentials for the media service, not content — they are not
 * stored and never reach Postgres.
 */
export const INDEXED_KINDS: readonly number[] = ALL_KINDS.filter(
  (kind) => kind !== KINDS.BLOSSOM_AUTH,
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

  const onEvent = async (event: SignedEvent): Promise<void> => {
    try {
      await indexEvent(db, event, counters, { now: nowSeconds(), sitePubkey: options.sitePubkey });
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
