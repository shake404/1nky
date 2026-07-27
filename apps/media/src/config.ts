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

/** Video MIME types accepted for upload (transcoded server-side via ffmpeg). */
export const ALLOWED_VIDEO_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

/** Formats `sharp` is allowed to have detected in the decoded input. */
export const ALLOWED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['webp', 'jpeg', 'jpg', 'png']);

/** Everything is re-encoded to this, so it is the only image type we store. */
export const STORED_CONTENT_TYPE = 'image/webp';

/** Videos are always transcoded to H.264 mp4, so this is the only video type stored. */
export const STORED_VIDEO_CONTENT_TYPE = 'video/mp4';

/** Content-addressed blobs are immutable — cache them forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** S3 user-metadata key holding the uploader's hex pubkey (owners map). */
export const UPLOADER_METADATA_KEY = 'uploader';

export interface MediaConfig {
  /** MEDIA_PORT — HTTP listen port. */
  readonly port: number;
  /** MAX_UPLOAD_MB, expanded to bytes. Image upload cap. */
  readonly maxUploadBytes: number;
  /** MAX_VIDEO_MB, expanded to bytes. Raw video upload cap (before transcode). */
  readonly maxVideoBytes: number;
  /** R2_BUCKET — bucket blobs are written to. */
  readonly bucket: string;
  /** MEDIA_PUBLIC_BASE — origin used to build blob descriptor URLs. */
  readonly publicBase: string;
  /** Longest edge (px) allowed out of the image re-encoder. */
  readonly maxDimension: number;
  /** WebP quality used by the defense-in-depth image re-encode. */
  readonly webpQuality: number;
  /**
   * ESCROW_ENABLED — when false (the default) every `/escrow` route answers
   * 404, so the endpoints ship dark until the web opt-in flow lands.
   */
  readonly escrowEnabled: boolean;
  /**
   * BLOSSOM_MIRROR_URL — origin of a public Blossom server that successfully
   * uploaded blobs are mirrored to (BUD-04 `PUT /mirror`). Undefined disables
   * mirroring entirely.
   */
  readonly mirrorUrl: string | undefined;
  /** BLOSSOM_MIRROR_CONCURRENCY — in-flight mirror requests. Default 1. */
  readonly mirrorConcurrency: number;
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

/** Truthy env spellings an operator might reasonably reach for. */
const TRUE_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on', 'enabled']);

function boolFromEnv(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return TRUE_VALUES.has(raw);
}

/**
 * Reads an optional http(s) origin. Returns undefined when unset (the feature
 * is off), and throws on something that is not a URL rather than silently
 * mirroring nowhere.
 */
function originFromEnv(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  return stripTrailingSlash(raw);
}

export function loadConfig(env: Env = process.env): MediaConfig {
  return {
    port: intFromEnv(env, 'MEDIA_PORT', 3002),
    maxUploadBytes: intFromEnv(env, 'MAX_UPLOAD_MB', 5) * 1024 * 1024,
    maxVideoBytes: intFromEnv(env, 'MAX_VIDEO_MB', 50) * 1024 * 1024,
    bucket: env['R2_BUCKET']?.trim() || '1nky-media',
    publicBase: stripTrailingSlash(env['MEDIA_PUBLIC_BASE']?.trim() || 'http://localhost:3002'),
    maxDimension: intFromEnv(env, 'MEDIA_MAX_DIMENSION', 4096),
    webpQuality: intFromEnv(env, 'MEDIA_WEBP_QUALITY', 82),
    escrowEnabled: boolFromEnv(env, 'ESCROW_ENABLED'),
    mirrorUrl: originFromEnv(env, 'BLOSSOM_MIRROR_URL'),
    mirrorConcurrency: intFromEnv(env, 'BLOSSOM_MIRROR_CONCURRENCY', 1),
  };
}

/**
 * S3/R2 connection settings. The endpoint is taken verbatim from
 * `R2_ENDPOINT` when set (lets any S3-compatible store / MinIO stand in), otherwise it is
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
