import {
  buildFlick,
  finalizeEvent,
  KINDS,
  type BuildFlickInput,
  type EventTemplate,
  type FlickDims,
  type SignedEvent,
} from '@1nky/protocol';
import imageCompression from 'browser-image-compression';
import {
  FULL_MAX_EDGE,
  MAX_UPLOAD_BYTES,
  MEDIA_BASE,
  THUMB_MAX_EDGE,
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

/**
 * Assemble the kind-20 input from the server's upload receipt.
 *
 * Split out from the network so the wiring between "what the server said"
 * and "what goes in the event" is testable on its own.
 */
export function flickInput(
  upload: UploadResult,
  dims: FlickDims,
  details: FlickDetails = {},
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
