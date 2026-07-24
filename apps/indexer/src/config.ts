/**
 * Indexer configuration. Everything comes from the environment — there is no
 * config file and no per-request configuration, because there are no requests.
 */

export interface IndexerConfig {
  /** Postgres connection string. */
  readonly databaseUrl: string;
  /** strfry websocket endpoint. */
  readonly relayWsUrl: string;
  /** How often the NIP-40 expiration sweep runs. */
  readonly sweepIntervalMs: number;
  /** First reconnect delay. Doubles up to `backoffMaxMs`. */
  readonly backoffInitialMs: number;
  /** Reconnect delay ceiling. */
  readonly backoffMaxMs: number;
  /**
   * Seconds of overlap re-requested on every reconnect. Relays can hand back
   * events slightly out of `created_at` order, so the watermark rewinds a
   * little; upserts are idempotent so replaying is free.
   */
  readonly watermarkOverlapSeconds: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key}: expected a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const databaseUrl = env['DATABASE_URL']?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const relayWsUrl = env['RELAY_WS_URL']?.trim();
  if (!relayWsUrl) throw new Error('RELAY_WS_URL is required');

  return {
    databaseUrl,
    relayWsUrl,
    sweepIntervalMs: intFromEnv(env, 'SWEEP_INTERVAL_MS', 60_000),
    backoffInitialMs: intFromEnv(env, 'RELAY_BACKOFF_INITIAL_MS', 1_000),
    backoffMaxMs: intFromEnv(env, 'RELAY_BACKOFF_MAX_MS', 30_000),
    watermarkOverlapSeconds: intFromEnv(env, 'WATERMARK_OVERLAP_SECONDS', 300),
  };
}

/**
 * Exponential backoff with full jitter, capped at `max`.
 * `attempt` is 0-based: the first retry waits ~`initial`.
 */
export function backoffDelay(
  attempt: number,
  initial: number,
  max: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(max, initial * 2 ** Math.max(0, attempt));
  return Math.round(exponential * (0.5 + random() * 0.5));
}
