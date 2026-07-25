import { pipeline } from 'node:stream/promises';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { KINDS } from '@1nky/protocol';

import { verifyBlossomAuth } from './auth.js';
import {
  ALLOWED_UPLOAD_TYPES,
  ALLOWED_VIDEO_TYPES,
  IMMUTABLE_CACHE_CONTROL,
  STORED_CONTENT_TYPE,
  STORED_VIDEO_CONTENT_TYPE,
  UPLOADER_METADATA_KEY,
  type MediaConfig,
} from './config.js';
import { HttpError, isHttpError } from './errors.js';
import {
  ESCROW_CACHE_CONTROL,
  ESCROW_CONTENT_TYPE,
  ESCROW_MAX_BYTES,
  escrowKey,
  parseEscrowPayload,
  parseEscrowPubkey,
} from './escrow.js';
import {
  drainRequest,
  isSha256Hex,
  normalizeContentType,
  parseBlobPath,
  parseSizeHeader,
  readBodyCapped,
  sha256Hex,
} from './http.js';
import { reencodeToWebp } from './image.js';
import type { MirrorJob, MirrorQueue } from './mirror.js';
import type { BlobStorage } from './storage.js';
import { transcodeVideo as defaultTranscodeVideo, type VideoTranscoder } from './video.js';

export interface AppDeps {
  readonly storage: BlobStorage;
  readonly config: MediaConfig;
  /** Injectable clock (unix seconds) so tests can pin expirations. */
  readonly now?: () => number;
  /**
   * Injectable video transcoder. Defaults to the real ffmpeg-based one; tests
   * inject a stub so `pnpm test` stays green without ffmpeg on CI.
   */
  readonly transcodeVideo?: VideoTranscoder;
  /**
   * Optional BUD-04 mirror queue. When absent, nothing is mirrored. Enqueueing
   * is best-effort and can never affect the upload's outcome.
   */
  readonly mirror?: MirrorQueue;
}

/** BUD-02 blob descriptor for an image upload. */
export interface BlobDescriptor {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
  readonly uploaded: number;
}

/**
 * Descriptor returned for a video upload. The `sha256`/`url` address the
 * transcoded mp4; `poster` addresses the webp still. The client puts
 * `sha256` into the kind-22 `x` tag and `poster.url` into the imeta `image`.
 */
export interface VideoDescriptor {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: 'video/mp4';
  readonly uploaded: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly poster: { readonly url: string; readonly sha256: string };
}

const EXPOSED_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Cache-Control',
  'ETag',
  'Last-Modified',
  'X-Reason',
  'X-SHA-256',
  'X-Upload-Message',
].join(', ');

const REJECTED_TYPE_MESSAGE =
  'only image/webp, image/jpeg, image/png, video/mp4, video/quicktime and video/webm are accepted';

function isVideoType(type: string): boolean {
  return ALLOWED_VIDEO_TYPES.has(type);
}

/** Byte cap that applies to a given accepted content type. */
function byteCapFor(config: MediaConfig, type: string): number {
  return isVideoType(type) ? config.maxVideoBytes : config.maxUploadBytes;
}

/**
 * Errors are logged as message + blob/kind context only.
 *
 * Hard rule: this service performs zero request logging. No URLs, no headers,
 * no IPs, no user agents — not on the happy path, not on the error path.
 */
function logError(message: string, context: Record<string, string | number | undefined>): void {
  const parts = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`media-error: ${message}${parts.length ? ` (${parts.join(' ')})` : ''}\n`);
}

/**
 * Records the blob a request is about so the error handler can name it.
 * Express clears `req.params` once a layer unwinds, and a sha256 is a content
 * address — not request metadata — so it is safe to keep.
 */
function rememberBlob(res: Response, sha256: string): void {
  (res.locals as Record<string, unknown>)['sha256'] = sha256;
}

function rememberedBlob(res: Response): string | undefined {
  const value = (res.locals as Record<string, unknown>)['sha256'];
  return typeof value === 'string' && isSha256Hex(value) ? value : undefined;
}

/**
 * Permissive CORS: authorization is a signed event carried in a header, so an
 * origin allowlist would buy nothing and break third-party Blossom clients.
 */
function cors(_req: Request, res: Response, next: NextFunction): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, *');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.set('Access-Control-Max-Age', '86400');
  next();
}

/** RFC 7232 weak/strong ETag comparison against a known-strong tag. */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (typeof header !== 'string' || header.trim() === '') return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag);
}

export function createApp(deps: AppDeps): Express {
  const { storage, config, mirror } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const transcode = deps.transcodeVideo ?? defaultTranscodeVideo;

  /**
   * Hands a stored blob to the mirror queue. Synchronous, swallows everything:
   * offsite redundancy is never allowed to turn a good upload into a bad one.
   */
  const queueMirror = (job: MirrorJob): void => {
    if (mirror === undefined) return;
    try {
      mirror.enqueue(job);
    } catch {
      // Best-effort by construction.
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(cors);

  app.options(/.*/, (_req, res) => {
    res.status(204).end();
  });

  // Liveness probe for compose/orchestrators. Reports nothing but "up".
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // --- BUD-06: upload requirements preflight ------------------------------
  app.head('/upload', (req, res) => {
    const declaredType = normalizeContentType(
      typeof req.headers['x-content-type'] === 'string' ? req.headers['x-content-type'] : undefined,
    );
    const declaredHash =
      typeof req.headers['x-sha-256'] === 'string' ? req.headers['x-sha-256'].toLowerCase() : '';
    const declaredLength = parseSizeHeader(
      typeof req.headers['x-content-length'] === 'string'
        ? req.headers['x-content-length']
        : undefined,
    );

    if (declaredHash !== '' && !isSha256Hex(declaredHash)) {
      res.set('X-Reason', 'X-SHA-256 must be a 64-character hex sha256').status(400).end();
      return;
    }
    const isVideo = declaredType !== '' && isVideoType(declaredType);
    const isImage = declaredType !== '' && ALLOWED_UPLOAD_TYPES.has(declaredType);
    if (declaredType !== '' && !isVideo && !isImage) {
      res.set('X-Reason', REJECTED_TYPE_MESSAGE).status(415).end();
      return;
    }
    if (declaredLength !== undefined && declaredLength > byteCapFor(config, isVideo ? 'video/mp4' : 'image/webp')) {
      res
        .set('X-Reason', `blob exceeds the ${byteCapFor(config, isVideo ? 'video/mp4' : 'image/webp')}-byte limit`)
        .status(413)
        .end();
      return;
    }
    res.status(200).end();
  });

  // --- BUD-02: upload ------------------------------------------------------
  app.put('/upload', async (req, res) => {
    const auth = verifyBlossomAuth(req.headers.authorization, { verb: 'upload', now: now() });

    const contentType = normalizeContentType(req.headers['content-type']);
    const video = isVideoType(contentType);
    const image = ALLOWED_UPLOAD_TYPES.has(contentType);
    if (!video && !image) {
      throw new HttpError(415, REJECTED_TYPE_MESSAGE);
    }

    const maxBytes = byteCapFor(config, contentType);
    const declaredLength = parseSizeHeader(req.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      throw new HttpError(413, `blob exceeds the ${maxBytes}-byte limit`);
    }

    const body = await readBodyCapped(req, maxBytes);
    if (body.truncated) {
      throw new HttpError(413, `blob exceeds the ${maxBytes}-byte limit`);
    }
    if (body.data.length === 0) {
      throw new HttpError(400, 'upload body is empty');
    }

    // The `x` tag must describe the bytes actually received.
    const receivedHash = sha256Hex(body.data);
    if (!auth.hashes.includes(receivedHash)) {
      throw new HttpError(400, 'uploaded bytes do not match the authorized sha256');
    }

    if (video) {
      const result = await transcode(body.data, {
        maxDurationSec: 60,
        maxWidth: 1280,
        maxHeight: 720,
        posterQuality: 80,
        inputMime: contentType,
      });

      // Addressed by the hash of the TRANSCODED bytes (which differ from the
      // client's `x` tag). The client MUST put the sha256 returned here into
      // the kind-22 `x` tag, or the event will point at a blob that does not
      // exist.
      const videoHash = sha256Hex(result.video);
      const posterHash = sha256Hex(result.poster);
      rememberBlob(res, videoHash);
      const uploaded = now();

      const videoExisting = await storage.head(videoHash);
      if (videoExisting === null) {
        await storage.put({
          key: videoHash,
          body: result.video,
          contentType: STORED_VIDEO_CONTENT_TYPE,
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          metadata: { [UPLOADER_METADATA_KEY]: auth.pubkey },
        });
      }
      const posterExisting = await storage.head(posterHash);
      if (posterExisting === null) {
        await storage.put({
          key: posterHash,
          body: result.poster,
          contentType: STORED_CONTENT_TYPE,
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          metadata: { [UPLOADER_METADATA_KEY]: auth.pubkey },
        });
      }

      const descriptor: VideoDescriptor = {
        url: `${config.publicBase}/${videoHash}`,
        sha256: videoHash,
        size: result.video.length,
        type: STORED_VIDEO_CONTENT_TYPE,
        uploaded,
        duration: result.duration,
        width: result.width,
        height: result.height,
        poster: { url: `${config.publicBase}/${posterHash}`, sha256: posterHash },
      };

      res.status(videoExisting === null ? 201 : 200).json(descriptor);

      // Both halves of a video post are public blobs worth mirroring.
      queueMirror({
        sha256: videoHash,
        url: descriptor.url,
        size: descriptor.size,
        mime: STORED_VIDEO_CONTENT_TYPE,
      });
      queueMirror({
        sha256: posterHash,
        url: descriptor.poster.url,
        size: result.poster.length,
        mime: STORED_CONTENT_TYPE,
      });
      return;
    }

    // --- image path --------------------------------------------------------
    const reencoded = await reencodeToWebp(body.data, {
      maxDimension: config.maxDimension,
      quality: config.webpQuality,
    });

    // IMPORTANT: the blob is addressed by the hash of the RE-ENCODED bytes,
    // which differs from the client's `x` tag. The client MUST put the sha256
    // returned in this descriptor (not the one it uploaded) into the `imeta`
    // tag of its kind-20 flick, or the event will point at a blob that does
    // not exist.
    const storedHash = sha256Hex(reencoded.data);
    rememberBlob(res, storedHash);
    const uploaded = now();

    const existing = await storage.head(storedHash);
    if (existing === null) {
      await storage.put({
        key: storedHash,
        body: reencoded.data,
        contentType: STORED_CONTENT_TYPE,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        metadata: { [UPLOADER_METADATA_KEY]: auth.pubkey },
      });
    }

    const descriptor: BlobDescriptor = {
      url: `${config.publicBase}/${storedHash}`,
      sha256: storedHash,
      size: reencoded.data.length,
      type: STORED_CONTENT_TYPE,
      uploaded,
    };

    res.status(existing === null ? 201 : 200).json(descriptor);

    queueMirror({
      sha256: storedHash,
      url: descriptor.url,
      size: descriptor.size,
      mime: STORED_CONTENT_TYPE,
    });
  });

  // --- Encrypted blackbook escrow -----------------------------------------
  // Registered ahead of the `/:blob` routes: `/escrow` is not a blob address
  // and would otherwise be rejected as a malformed hash.

  /** Off by default — the endpoints do not exist until an operator says so. */
  const requireEscrowEnabled = (): void => {
    if (!config.escrowEnabled) {
      throw new HttpError(404, 'not found');
    }
  };

  app.put('/escrow', async (req, res) => {
    requireEscrowEnabled();

    // The signer IS the subject: you can only escrow your own blackbook.
    const auth = verifyBlossomAuth(req.headers.authorization, { verb: 'escrow', now: now() });

    const declaredLength = parseSizeHeader(req.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > ESCROW_MAX_BYTES) {
      throw new HttpError(400, `escrowed blackbook exceeds the ${ESCROW_MAX_BYTES}-byte limit`);
    }

    const body = await readBodyCapped(req, ESCROW_MAX_BYTES);
    if (body.truncated) {
      throw new HttpError(400, `escrowed blackbook exceeds the ${ESCROW_MAX_BYTES}-byte limit`);
    }

    const payload = parseEscrowPayload(body.data);
    const key = escrowKey(auth.pubkey);

    const existing = await storage.head(key);
    await storage.put({
      key,
      body: Buffer.from(payload, 'utf8'),
      contentType: ESCROW_CONTENT_TYPE,
      cacheControl: ESCROW_CACHE_CONTROL,
      // Redundant with the key, but keeps the ownership convention uniform.
      metadata: { [UPLOADER_METADATA_KEY]: auth.pubkey },
    });

    res.status(existing === null ? 201 : 200).json({ stored: true });
  });

  app.get('/escrow/:pubkey', async (req, res) => {
    requireEscrowEnabled();

    // No auth: the payload is passphrase-locked, and a writer who has lost
    // their key cannot sign anything — which is exactly when they need this.
    const pubkey = parseEscrowPubkey(req.params.pubkey);
    const stored = await storage.get(escrowKey(pubkey));
    if (stored === null) {
      throw new HttpError(404, 'no blackbook is escrowed for this mark');
    }

    res.set('Content-Type', ESCROW_CONTENT_TYPE);
    res.set('Cache-Control', ESCROW_CACHE_CONTROL);
    res.status(200);
    await pipeline(stored.body, res);
  });

  app.delete('/escrow', async (req, res) => {
    requireEscrowEnabled();

    const auth = verifyBlossomAuth(req.headers.authorization, { verb: 'escrow', now: now() });
    const key = escrowKey(auth.pubkey);

    const existing = await storage.head(key);
    if (existing === null) {
      throw new HttpError(404, 'no blackbook is escrowed for this mark');
    }

    await storage.delete(key);
    res.status(200).json({ deleted: true });
  });

  // --- BUD-01: retrieval ---------------------------------------------------
  app.head('/:blob', async (req, res) => {
    const sha256 = parseBlobPath(req.params.blob);
    rememberBlob(res, sha256);
    const head = await storage.head(sha256);
    if (head === null) {
      res.set('X-Reason', 'blob not found').status(404).end();
      return;
    }
    res.set('ETag', `"${sha256}"`);
    res.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    res.set('Content-Type', head.contentType);
    res.set('Content-Length', String(head.size));
    res.set('Accept-Ranges', 'bytes');
    res.status(ifNoneMatchHits(req.headers['if-none-match'], `"${sha256}"`) ? 304 : 200).end();
  });

  app.get('/:blob', async (req, res) => {
    const sha256 = parseBlobPath(req.params.blob);
    rememberBlob(res, sha256);
    const etag = `"${sha256}"`;

    res.set('ETag', etag);
    res.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);

    if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
      // Content-addressed bytes can never change, so a matching ETag is
      // always fresh — no need to touch storage at all.
      res.status(304).end();
      return;
    }

    const blob = await storage.get(sha256);
    if (blob === null) {
      throw new HttpError(404, 'blob not found');
    }

    res.set('Content-Type', blob.contentType);
    res.set('Content-Length', String(blob.size));
    res.set('Accept-Ranges', 'bytes');
    res.status(200);
    await pipeline(blob.body, res);
  });

  // --- BUD-02/BUD-12: delete ----------------------------------------------
  app.delete('/:blob', async (req, res) => {
    const sha256 = parseBlobPath(req.params.blob);
    rememberBlob(res, sha256);
    const auth = verifyBlossomAuth(req.headers.authorization, {
      verb: 'delete',
      now: now(),
      requireX: sha256,
    });

    const head = await storage.head(sha256);
    if (head === null) {
      throw new HttpError(404, 'blob not found');
    }

    // The owners map lives in S3 user metadata (x-amz-meta-uploader) so it
    // survives a rebuild of every other piece of state.
    const owner = head.metadata[UPLOADER_METADATA_KEY];
    if (owner === undefined || owner.toLowerCase() !== auth.pubkey.toLowerCase()) {
      throw new HttpError(403, 'only the original uploader may delete this blob');
    }

    await storage.delete(sha256);
    res.status(200).json({ deleted: true, sha256 });
  });

  app.use((_req, res) => {
    res.set('X-Reason', 'not found').status(404).json({ error: 'not found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = isHttpError(err) ? err.status : 500;
    const message = isHttpError(err)
      ? err.message
      : err instanceof Error
        ? err.message
        : 'internal error';

    // Context is limited to content-addressed / protocol facts. Never headers,
    // never connection info.
    logError(message, {
      status,
      sha256: rememberedBlob(res),
      kind: status === 401 ? KINDS.BLOSSOM_AUTH : undefined,
    });

    if (res.headersSent) {
      res.end();
      return;
    }

    // Swallow any unread request body first, otherwise the client can lose the
    // response to a socket teardown.
    void drainRequest(req).then(() => {
      res.set('X-Reason', message);
      res.status(status).json({ error: status === 500 ? 'internal error' : message });
    });
  });

  return app;
}
