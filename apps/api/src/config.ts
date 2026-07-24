/** API configuration. Environment only — see the app README for the vars. */

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly port: number;
  /**
   * Shared secret for `/mod/*`, sent as the `X-Mod-Key` header. When unset the
   * moderation endpoints answer 503: an unauthenticated mod queue is worse
   * than no mod queue.
   */
  readonly modApiKey: string | undefined;
  /** Hard ceiling on `?limit=`. */
  readonly maxLimit: number;
  readonly defaultLimit: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = env['DATABASE_URL']?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  return {
    databaseUrl,
    port: intFromEnv(env, 'API_PORT', 3001),
    modApiKey: env['MOD_API_KEY']?.trim() || undefined,
    maxLimit: 50,
    defaultLimit: 24,
  };
}
