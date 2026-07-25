/**
 * Runtime configuration. Every value has a working localhost default so a
 * fresh clone runs with no .env at all.
 *
 * Defaults mirror the repo's `.env.example` — keep them in sync.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

const env = import.meta.env;

/** WebSocket endpoint for the write path. */
export const RELAY_WS_URL = env.VITE_RELAY_WS_URL ?? 'ws://localhost:7777';

/** Read-only REST API (feeds, search). Never used for writes. */
export const API_BASE = trimSlash(env.VITE_API_BASE ?? 'http://localhost:3001');

/** Blossom-compatible media service. */
export const MEDIA_BASE = trimSlash(env.VITE_MEDIA_BASE ?? 'http://localhost:3002');

/**
 * NIP-13 difficulty targets. Defaults match `.env.example`
 * (POW_BITS_NEW / POW_BITS_POST / POW_BITS_REACTION).
 */
export const POW_BITS = {
  /** First event ever from a fresh tag. Deliberately the expensive one. */
  new: num(env.VITE_POW_BITS_NEW, 18),
  /** Ordinary posts, comments, buffs. */
  post: num(env.VITE_POW_BITS_POST, 13),
  /** Cheap interactions. */
  reaction: num(env.VITE_POW_BITS_REACTION, 8),
} as const;

/** Hard client-side upload ceiling for pictures, matched by the media service. */
export const MAX_UPLOAD_BYTES = num(env.VITE_MAX_UPLOAD_MB, 5) * 1024 * 1024;

/** Hard client-side upload ceiling for video clips. */
export const MAX_VIDEO_BYTES = num(env.VITE_MAX_VIDEO_MB, 50) * 1024 * 1024;

/** Longest accepted video clip, in seconds. A clip, not a reel. */
export const VIDEO_MAX_DURATION_SEC = 60;

/** Diagnostics panel in Settings. Off unless explicitly switched on. */
export const SHOW_FLAGS = env.VITE_SHOW_FLAGS === '1';

/** Longest edge of a posted flick, in pixels. */
export const FULL_MAX_EDGE = 2048;
/** Longest edge of the generated thumbnail. */
export const THUMB_MAX_EDGE = 512;
/** WebP quality for both sizes. */
export const WEBP_QUALITY = 0.82;
