import {
  buildFlick,
  buildVideo,
  finalizeEvent,
  KINDS,
  type BuildFlickInput,
  type BuildVideoInput,
  type EventTemplate,
  type FlickDims,
  type GrafType,
  type SignedEvent,
  type Surface,
} from '@1nky/protocol';
import imageCompression from 'browser-image-compression';
import {
  FULL_MAX_EDGE,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MEDIA_BASE,
  THUMB_MAX_EDGE,
  VIDEO_MAX_DURATION_SEC,
  WEBP_QUALITY,
} from './config.js';

/**
 * The flick pipeline: camera roll -> stripped, resized WebP -> media service
 * -> kind-20 event.
 *
 * Nothing identifying ever leaves the device. The canvas re-encode below is
 * the load-bearing step: drawing decoded pixels into a fresh canvas and
 * re-encoding produces a file with no EXIF at all — no GPS, no capture time,
 * no camera serial, no embedded thumbnail. The server re-encodes again as
 * defence in depth, but by then there is already nothing to strip.
 */

export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  dims: FlickDims;
}

export interface UploadResult {
  /** Hex sha256 of the bytes the SERVER stored. This is the blob's address. */
  sha256: string;
  url: string;
  size?: number;
  mime?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

// --- Step 1: strip + resize + encode ----------------------------------------

/**
 * Re-encode through a canvas. This is what destroys metadata.
 *
 * Uses `OffscreenCanvas` where available (keeps the paint off the main
 * thread) and falls back to a detached `<canvas>` elsewhere.
 */
async function canvasReencode(source: Blob, maxEdge: number, quality: number): Promise<{ blob: Blob; dims: FlickDims }> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not read that picture.');
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
      return { blob, dims: { width, height } };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not read that picture.');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality),
    );
    if (!blob) throw new Error('Could not read that picture.');
    return { blob, dims: { width, height } };
  } finally {
    bitmap.close();
  }
}

/**
 * Compress, resize and strip a picked file, plus a 512px thumbnail.
 *
 * `browser-image-compression` does the heavy resize inside its own worker;
 * we then run our own canvas pass so the EXIF guarantee does not depend on
 * a third party's implementation details.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Pictures only.');
  }

  const compressed = await imageCompression(file, {
    maxWidthOrHeight: FULL_MAX_EDGE,
    fileType: 'image/webp',
    initialQuality: WEBP_QUALITY,
    useWebWorker: true,
    preserveExif: false,
    maxSizeMB: MAX_UPLOAD_BYTES / (1024 * 1024),
  });

  const full = await canvasReencode(compressed, FULL_MAX_EDGE, WEBP_QUALITY);
  const thumb = await canvasReencode(compressed, THUMB_MAX_EDGE, WEBP_QUALITY);

  if (full.blob.size > MAX_UPLOAD_BYTES) {
    throw new Error('That picture is too big. Try a smaller one.');
  }

  return { full: full.blob, thumb: thumb.blob, dims: full.dims };
}

// --- Step 2: address it ------------------------------------------------------

/** Hex sha256 of a blob, via WebCrypto. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Step 3: upload ----------------------------------------------------------

/** Build the kind-24242 upload authorisation the media service checks. */
export function buildUploadAuth(
  hash: string,
  size: number,
  now = Math.floor(Date.now() / 1000),
): EventTemplate {
  return {
    kind: KINDS.BLOSSOM_AUTH,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['size', String(size)],
      ['expiration', String(now + 300)],
    ],
    content: 'Put a flick up',
  };
}

function authHeader(event: SignedEvent): string {
  const json = JSON.stringify(event);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary)}`;
}

/**
 * Normalise whatever the media service answered with.
 *
 * The server re-encodes, so the bytes it stored are NOT the bytes we sent —
 * its hash is the real address and the client's is only an upload receipt.
 * Server hash wins, always: putting our own hash in the event would point at
 * a blob that does not exist.
 */
export function parseUploadResponse(payload: unknown, mediaBase: string = MEDIA_BASE): UploadResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The picture did not go up. Try again.');
  }
  const body = payload as Record<string, unknown>;
  const sha256 = typeof body['sha256'] === 'string' ? body['sha256'].toLowerCase() : '';
  if (!HEX64.test(sha256)) throw new Error('The picture did not go up. Try again.');

  const url =
    typeof body['url'] === 'string' && body['url']
      ? body['url']
      : `${mediaBase.replace(/\/+$/, '')}/${sha256}`;

  const rawSize = body['size'];
  const rawMime = typeof body['type'] === 'string' ? body['type'] : body['mime'];

  return {
    sha256,
    url,
    ...(typeof rawSize === 'number' && Number.isFinite(rawSize) ? { size: rawSize } : {}),
    ...(typeof rawMime === 'string' && rawMime ? { mime: rawMime } : {}),
  };
}

export async function uploadBlob(
  blob: Blob,
  secret: Uint8Array,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const hash = await sha256Hex(blob);
  const auth = finalizeEvent(buildUploadAuth(hash, blob.size), secret);

  const response = await fetch(`${MEDIA_BASE}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': blob.type || 'image/webp',
    },
    body: blob,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 413 ? 'That picture is too big. Try a smaller one.' : 'The picture did not go up. Try again.',
    );
  }
  return parseUploadResponse(await response.json());
}

// --- Step 4: describe it -----------------------------------------------------

export interface FlickDetails {
  caption?: string;
  alt?: string;
  boards?: readonly string[];
  contentWarning?: string;
}

/** Facets shared by flicks and videos — the Explore `t`-tag vocabularies. */
export interface MediaFacets {
  /** Graffiti type facets, emitted as `type-*` `t` tags. */
  types?: readonly GrafType[];
  /** Surface facets, emitted as `surface-*` `t` tags. */
  surfaces?: readonly Surface[];
  /** Region facet, emitted as a single `region-*` `t` tag. */
  region?: string;
  /** When true, emits a `legal-permission` `t` tag (the only legal facet). */
  legalPermission?: boolean;
}

export interface MediaDetails extends FlickDetails, MediaFacets {}

/**
 * Assemble the kind-20 input from the server's upload receipt.
 *
 * Split out from the network so the wiring between "what the server said"
 * and "what goes in the event" is testable on its own.
 */
export function flickInput(
  upload: UploadResult,
  dims: FlickDims,
  details: MediaDetails = {},
): BuildFlickInput {
  return {
    url: upload.url,
    sha256: upload.sha256,
    dims,
    mime: upload.mime ?? 'image/webp',
    ...(upload.size !== undefined ? { size: upload.size } : {}),
    ...(details.caption ? { caption: details.caption } : {}),
    ...(details.alt ? { alt: details.alt } : {}),
    ...(details.boards?.length ? { boards: details.boards } : {}),
    ...(details.types?.length ? { types: details.types } : {}),
    ...(details.surfaces?.length ? { surfaces: details.surfaces } : {}),
    ...(details.region ? { region: details.region } : {}),
    ...(details.legalPermission ? { legalPermission: true } : {}),
    ...(details.contentWarning ? { contentWarning: details.contentWarning } : {}),
  };
}

export function flickTemplate(
  upload: UploadResult,
  dims: FlickDims,
  details: FlickDetails = {},
): EventTemplate {
  return buildFlick(flickInput(upload, dims, details));
}

// ---------------------------------------------------------------------------
// Video (kind 22, NIP-71) — same pipeline shape, different media.
// ---------------------------------------------------------------------------

/** What the client probes from a picked clip before it ever uploads. */
export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Load a video file into a detached `<video>` element to read its true
 * duration and dimensions. This is the load-bearing gate: a clip longer than
 * `VIDEO_MAX_DURATION_SEC` or bigger than `MAX_VIDEO_BYTES` is refused here,
 * before any bytes leave the device.
 *
 * @throws copy-deck-safe messages — never protocol vocabulary.
 */
export function probeVideo(file: File): Promise<VideoProbe> {
  return new Promise<VideoProbe>((resolve, reject) => {
    if (!file.type.startsWith('video/')) {
      reject(new Error('Clips only.'));
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      reject(new Error('Clip too big.'));
      return;
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      URL.revokeObjectURL(url);
      try {
        video.removeAttribute('src');
        video.load?.();
      } catch {
        /* some test DOMs have no media element implementation */
      }
    };
    const fail = (message: string): void => {
      if (settled) return;
      cleanup();
      reject(new Error(message));
    };
    video.onerror = () => fail('Could not read that clip.');
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!Number.isFinite(duration) || duration <= 0) {
        fail('Could not read that clip.');
        return;
      }
      if (duration > VIDEO_MAX_DURATION_SEC) {
        fail(`Too long. ${VIDEO_MAX_DURATION_SEC} seconds max.`);
        return;
      }
      if (!width || !height) {
        fail('Could not read that clip.');
        return;
      }
      cleanup();
      resolve({ durationSec: duration, width, height });
    };
    // A safety net: some engines never fire onerror for a corrupt file.
    setTimeout(() => fail('Could not read that clip.'), 15_000);
    video.src = url;
  });
}

/** Sub-shape of {@link parseUploadResponse}, kept narrow for video. */
export interface VideoPosterResult {
  sha256: string;
  url: string;
}

/**
 * The media service's video receipt. The raw clip is uploaded (the service
 * transcodes and returns the transcoded bytes' address), plus a separate
 * poster still — both addressed by the SERVER's hash, since it re-encodes.
 */
export interface VideoDescriptor {
  url: string;
  sha256: string;
  /** Byte length of the stored (transcoded) video. */
  size?: number;
  type: 'video/mp4';
  duration: number;
  width: number;
  height: number;
  poster: VideoPosterResult;
}

/**
 * Normalise a video upload response into a {@link VideoDescriptor}.
 *
 * The server routes by Content-Type and answers with the fields above. We are
 * deliberately defensive: a missing poster or duration makes a kind-22 event
 * unusable, so we refuse rather than emit a half-descriptor.
 */
export function parseVideoUploadResponse(
  payload: unknown,
  mediaBase: string = MEDIA_BASE,
): VideoDescriptor {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The clip did not go up. Try again.');
  }
  const body = payload as Record<string, unknown>;
  const sha256 = typeof body['sha256'] === 'string' ? body['sha256'].toLowerCase() : '';
  if (!HEX64.test(sha256)) throw new Error('The clip did not go up. Try again.');

  const url =
    typeof body['url'] === 'string' && body['url']
      ? body['url']
      : `${mediaBase.replace(/\/+$/, '')}/${sha256}`;

  const duration = typeof body['duration'] === 'number' ? body['duration'] : NaN;
  const width = typeof body['width'] === 'number' ? body['width'] : 0;
  const height = typeof body['height'] === 'number' ? body['height'] : 0;
  if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
    throw new Error('The clip did not go up. Try again.');
  }

  const posterRaw = body['poster'];
  const poster =
    typeof posterRaw === 'object' && posterRaw !== null ? (posterRaw as Record<string, unknown>) : null;
  const posterSha =
    typeof poster?.['sha256'] === 'string' ? poster['sha256'].toLowerCase() : '';
  const posterUrl =
    typeof poster?.['url'] === 'string' && poster['url']
      ? poster['url']
      : posterSha
        ? `${mediaBase.replace(/\/+$/, '')}/${posterSha}`
        : '';
  if (!posterUrl || !HEX64.test(posterSha)) {
    throw new Error('The clip did not go up. Try again.');
  }

  const rawSize = body['size'];
  return {
    url,
    sha256,
    type: 'video/mp4',
    duration,
    width,
    height,
    poster: { sha256: posterSha, url: posterUrl },
    ...(typeof rawSize === 'number' && Number.isFinite(rawSize) ? { size: rawSize } : {}),
  };
}

/**
 * Assemble the kind-22 input from the server's video descriptor.
 *
 * Split out from the network so the wiring between "what the server said" and
 * "what goes in the event" is testable on its own — exactly like
 * {@link flickInput} for kind 20.
 */
export function videoInput(
  descriptor: VideoDescriptor,
  details: MediaDetails = {},
): BuildVideoInput {
  return {
    url: descriptor.url,
    sha256: descriptor.sha256,
    dims: { width: descriptor.width, height: descriptor.height },
    durationSec: descriptor.duration,
    poster: descriptor.poster.url,
    mime: 'video/mp4',
    ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
    ...(details.caption ? { caption: details.caption } : {}),
    ...(details.alt ? { alt: details.alt } : {}),
    ...(details.boards?.length ? { boards: details.boards } : {}),
    ...(details.types?.length ? { types: details.types } : {}),
    ...(details.surfaces?.length ? { surfaces: details.surfaces } : {}),
    ...(details.region ? { region: details.region } : {}),
    ...(details.legalPermission ? { legalPermission: true } : {}),
    ...(details.contentWarning ? { contentWarning: details.contentWarning } : {}),
  };
}

export function videoTemplate(
  descriptor: VideoDescriptor,
  details: MediaDetails = {},
): EventTemplate {
  return buildVideo(videoInput(descriptor, details));
}

/**
 * Upload a raw video clip. Reuses the EXISTING image upload-auth code path:
 * the kind-24242 auth event and `Authorization: Nostr …` header are produced
 * by {@link uploadBlob}; the media service routes by Content-Type and returns
 * a {@link VideoDescriptor}-shaped body, which {@link parseVideoUploadResponse}
 * normalises.
 */
export async function uploadVideo(
  file: File,
  secret: Uint8Array,
  signal?: AbortSignal,
): Promise<VideoDescriptor> {
  const hash = await sha256Hex(file);
  const auth = finalizeEvent(buildUploadAuth(hash, file.size), secret);

  const response = await fetch(`${MEDIA_BASE}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': file.type || 'video/mp4',
    },
    body: file,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 413 ? 'Clip too big.' : 'The clip did not go up. Try again.',
    );
  }
  return parseVideoUploadResponse(await response.json());
}
