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
  IMMUTABLE_CACHE_CONTROL,
  STORED_CONTENT_TYPE,
  UPLOADER_METADATA_KEY,
  type MediaConfig,
} from './config.js';
import { HttpError, isHttpError } from './errors.js';
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
import type { BlobStorage } from './storage.js';

export interface AppDeps {
  readonly storage: BlobStorage;
  readonly config: MediaConfig;
  /** Injectable clock (unix seconds) so tests can pin expirations. */
  readonly now?: () => number;
}

/** BUD-02 blob descriptor. */
export interface BlobDescriptor {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
  readonly uploaded: number;
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
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

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
    if (declaredType !== '' && !ALLOWED_UPLOAD_TYPES.has(declaredType)) {
      res.set('X-Reason', 'only image/webp, image/jpeg and image/png are accepted').status(415).end();
      return;
    }
    if (declaredLength !== undefined && declaredLength > config.maxUploadBytes) {
      res
        .set('X-Reason', `blob exceeds the ${config.maxUploadBytes}-byte limit`)
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
    if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
      throw new HttpError(415, 'only image/webp, image/jpeg and image/png are accepted');
    }

    const declaredLength = parseSizeHeader(req.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > config.maxUploadBytes) {
      throw new HttpError(413, `blob exceeds the ${config.maxUploadBytes}-byte limit`);
    }

    const body = await readBodyCapped(req, config.maxUploadBytes);
    if (body.truncated) {
      throw new HttpError(413, `blob exceeds the ${config.maxUploadBytes}-byte limit`);
    }
    if (body.data.length === 0) {
      throw new HttpError(400, 'upload body is empty');
    }

    // The `x` tag must describe the bytes actually received.
    const receivedHash = sha256Hex(body.data);
    if (!auth.hashes.includes(receivedHash)) {
      throw new HttpError(400, 'uploaded bytes do not match the authorized sha256');
    }

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
