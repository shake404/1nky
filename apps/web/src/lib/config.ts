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

// --- Onion-ready service bases -----------------------------------------------

/**
 * The three service addresses, derived rather than baked.
 *
 * The wall's normal build stamps absolute URLs in at compile time, which is
 * right for 1nky.com and wrong for a hidden service: an `.onion` visitor who
 * gets handed `https://api.1nky.com` has just been told to leave Tor, and the
 * whole point of the address was that they never do. So on a `.onion` host the
 * three bases are recomputed from the address bar itself — everything rides the
 * one origin, and the vhost in front puts `/api`, `/media` and `/relay` where
 * they belong.
 */
export interface ServiceBases {
  api: string;
  media: string;
  relay: string;
}

/** Just enough of `Location` to derive from. */
export interface BaseLocation {
  hostname?: string;
  origin?: string;
  protocol?: string;
  host?: string;
}

/**
 * Same-origin bases for a hidden-service host, or null when the baked values
 * should win.
 *
 * Null is the answer for 1nky.com, for a LAN box, and — importantly — for
 * vitest, where `location.hostname` is `localhost`: the tests and the dev box
 * both keep the localhost defaults they have always had.
 */
export function derivedBases(loc: BaseLocation | undefined | null): ServiceBases | null {
  const hostname = (loc?.hostname ?? '').toLowerCase();
  if (!hostname.endsWith('.onion')) return null;

  const protocol = loc?.protocol ?? 'http:';
  const host = loc?.host ?? hostname;
  const origin = trimSlash(loc?.origin ?? `${protocol}//${host}`);
  return {
    api: `${origin}/api`,
    media: `${origin}/media`,
    relay: `ws${protocol === 'https:' ? 's' : ''}://${host}/relay`,
  };
}

/**
 * Computed once, at module init — the address bar cannot change under us
 * without a reload, and a getter on every fetch would only buy re-reading a
 * constant.
 */
const derived = derivedBases(typeof location === 'undefined' ? null : location);

/** WebSocket endpoint for the write path. */
export const RELAY_WS_URL = derived?.relay ?? env.VITE_RELAY_WS_URL ?? 'ws://localhost:7777';

/** Read-only REST API (feeds, search). Never used for writes. */
export const API_BASE = derived?.api ?? trimSlash(env.VITE_API_BASE ?? 'http://localhost:3001');

/** Blossom-compatible media service. */
export const MEDIA_BASE = derived?.media ?? trimSlash(env.VITE_MEDIA_BASE ?? 'http://localhost:3002');

/** True when the three bases above came off the address bar, not the build. */
export const SAME_ORIGIN_SERVICES = derived !== null;

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
