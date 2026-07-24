/**
 * Environment-driven configuration. Every knob comes from the root
 * `.env.example` contract — nothing is invented here, and nothing in this file
 * may ever enable request logging or capture connection metadata.
 */

/** MIME types the service will accept on the wire. */
export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  'image/webp',
  'image/jpeg',
  'image/png',
]);

/** Formats `sharp` is allowed to have detected in the decoded input. */
export const ALLOWED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['webp', 'jpeg', 'jpg', 'png']);

/** Everything is re-encoded to this, so it is the only type we ever store. */
export const STORED_CONTENT_TYPE = 'image/webp';

/** Content-addressed blobs are immutable — cache them forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** S3 user-metadata key holding the uploader's hex pubkey (owners map). */
export const UPLOADER_METADATA_KEY = 'uploader';

export interface MediaConfig {
  /** MEDIA_PORT — HTTP listen port. */
  readonly port: number;
  /** MAX_UPLOAD_MB, expanded to bytes. */
  readonly maxUploadBytes: number;
  /** R2_BUCKET — bucket blobs are written to. */
  readonly bucket: string;
  /** MEDIA_PUBLIC_BASE — origin used to build blob descriptor URLs. */
  readonly publicBase: string;
  /** Longest edge (px) allowed out of the re-encoder. */
  readonly maxDimension: number;
  /** WebP quality used by the defense-in-depth re-encode. */
  readonly webpQuality: number;
}

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export type Env = Record<string, string | undefined>;

function intFromEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): MediaConfig {
  return {
    port: intFromEnv(env, 'MEDIA_PORT', 3002),
    maxUploadBytes: intFromEnv(env, 'MAX_UPLOAD_MB', 5) * 1024 * 1024,
    bucket: env['R2_BUCKET']?.trim() || '1nky-media',
    publicBase: stripTrailingSlash(env['MEDIA_PUBLIC_BASE']?.trim() || 'http://localhost:3002'),
    maxDimension: intFromEnv(env, 'MEDIA_MAX_DIMENSION', 4096),
    webpQuality: intFromEnv(env, 'MEDIA_WEBP_QUALITY', 82),
  };
}

/**
 * S3/R2 connection settings. The endpoint is taken verbatim from
 * `R2_ENDPOINT` when set (lets DO Spaces / MinIO stand in), otherwise it is
 * derived from the Cloudflare account id.
 */
export function loadS3Config(env: Env = process.env): S3Config {
  const accountId = env['R2_ACCOUNT_ID']?.trim() ?? '';
  const explicitEndpoint = env['R2_ENDPOINT']?.trim() ?? '';
  const endpoint = explicitEndpoint || `https://${accountId}.r2.cloudflarestorage.com`;

  if (!explicitEndpoint && accountId === '') {
    throw new Error('Set R2_ENDPOINT or R2_ACCOUNT_ID so the S3 endpoint can be resolved');
  }

  const accessKeyId = env['R2_ACCESS_KEY_ID']?.trim() ?? '';
  const secretAccessKey = env['R2_SECRET_ACCESS_KEY']?.trim() ?? '';
  if (accessKeyId === '' || secretAccessKey === '') {
    throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  }

  return {
    endpoint: stripTrailingSlash(endpoint),
    region: 'auto',
    bucket: env['R2_BUCKET']?.trim() || '1nky-media',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  };
}
