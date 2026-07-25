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
  /**
   * Site moderators, lowercase hex, parsed once from `SITE_MOD_PUBKEYS`.
   *
   * Two powers hang off this set and nothing else does: applying a kind-30078
   * ban/unban to `banned_pubkeys`, and honouring a kind-5 takedown of an event
   * the signer did not author. From any other signer both are inert.
   */
  readonly modPubkeys: ReadonlySet<string>;
  /**
   * Where `banned_pubkeys` is exported as the JSON file strfry's write policy
   * hot-reloads. Undefined (the default) disables the export entirely, which is
   * what you want on a dev box with no relay bind mount.
   */
  readonly banListExportPath: string | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `SITE_MOD_PUBKEYS` — a comma-separated list of 32-byte hex pubkeys.
 *
 * Parsed once at startup so the hot path is a `Set.has` rather than a split per
 * event. Comparison is case-insensitive: entries are lowercased going in and
 * the store lowercases the signer going out. Anything that is not 64 hex
 * characters is dropped silently — it is a pubkey, so it is never logged, and a
 * half-matched prefix must never grant moderator powers.
 */
export function parseModPubkeys(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (raw === undefined) return out;
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase();
    if (HEX64.test(value)) out.add(value);
  }
  return out;
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
    modPubkeys: parseModPubkeys(env['SITE_MOD_PUBKEYS']),
    banListExportPath: env['BAN_LIST_EXPORT_PATH']?.trim() || undefined,
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
