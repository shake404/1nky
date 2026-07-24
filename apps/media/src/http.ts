import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { HttpError } from './errors.js';

/** Lowercase hex SHA-256 of a buffer — the only address a blob ever has. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** True when `value` is a lowercase 64-char hex string. */
export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}

/**
 * Splits an optional file extension off a Blossom path segment
 * (`<sha256>.webp` → `<sha256>`) and validates the hash. Runs before any
 * storage call so junk paths never reach the bucket.
 */
export function parseBlobPath(param: string): string {
  const dot = param.indexOf('.');
  const raw = (dot === -1 ? param : param.slice(0, dot)).toLowerCase();
  if (!isSha256Hex(raw)) {
    throw new HttpError(400, 'blob path must be a 64-character hex sha256');
  }
  return raw;
}

/** Strips parameters off a Content-Type value: `image/png; charset=x` → `image/png`. */
export function normalizeContentType(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const semi = value.indexOf(';');
  return (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
}

/** Parses a non-negative integer header, returning undefined when absent/garbage. */
export function parseSizeHeader(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Consumes and discards whatever is left of a request body.
 *
 * Rejections (bad auth, wrong type, too big) happen before the body has been
 * read. Answering without draining makes Node tear the socket down and the
 * client usually loses the response, so we swallow the remaining bytes first.
 */
export function drainRequest(req: IncomingMessage, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed || req.readable === false) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('end', finish);
      req.off('error', finish);
      req.off('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish();
    }, timeoutMs);
    timer.unref();

    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
    req.resume();
  });
}

export interface CappedBody {
  readonly data: Buffer;
  /** True when the peer sent more than `maxBytes`. */
  readonly truncated: boolean;
}

/**
 * Reads a request body, refusing to buffer more than `maxBytes`.
 *
 * The stream is always drained rather than destroyed: killing the socket
 * mid-upload tends to lose the response, and the client deserves to be told
 * why it was rejected.
 */
export function readBodyCapped(req: IncomingMessage, maxBytes: number): Promise<CappedBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ data: truncated ? Buffer.alloc(0) : Buffer.concat(chunks), truncated });
    };

    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpError(400, 'upload stream failed'));
    };

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}
