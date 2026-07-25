import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { ApiConfig } from './config.js';
import { type Cursor, decodeCursor } from './cursor.js';

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const IPV4_LIKE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;
// No leading `\b`: an IPv6 loopback (`::1`) starts with a non-word character.
const IPV6_LIKE = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:.])/gi;

/**
 * Strips anything address-shaped out of a message before it reaches stderr.
 *
 * These are the *server's* addresses — Node writes them into errors like
 * `connect ECONNREFUSED 127.0.0.1:5432`, and a caller's address never reaches
 * this code at all. Redacting anyway costs nothing and removes the question.
 */
export function redact(message: string): string {
  return message
    .replace(URL_LIKE, '[address]')
    .replace(IPV4_LIKE, '[address]')
    .replace(IPV6_LIKE, '[address]');
}

/** An error with an HTTP status. Anything else becomes a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);

/**
 * CORS: wide open, because everything this service returns is public content
 * that anyone could read from the relay anyway.
 *
 * There is no `Access-Control-Allow-Credentials` and there are no cookies:
 * identity lives in the client's keypair, and the server has no notion of a
 * logged-in anybody.
 */
export const cors: RequestHandler = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mod-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
};

/**
 * Hard rule #4, enforced at the door as well as by the route table: this
 * service is read-only. Writes are signed events published to the relay.
 */
export const readOnly: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  next(new HttpError(405, 'read_only', 'This API is read-only. Publish a signed event instead.'));
};

/** Constant-time secret comparison that does not leak the secret's length. */
export function secretsMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Gate for `/mod/*`. A shared secret in `X-Mod-Key`, nothing more: mods are
 * few, the endpoints are read-only, and a session system would mean storing
 * something about a person.
 */
export function requireModKey(config: ApiConfig): RequestHandler {
  return (req, _res, next) => {
    const expected = config.modApiKey;
    if (!expected) {
      next(new HttpError(503, 'mod_disabled', 'Moderation endpoints are not configured.'));
      return;
    }
    const provided = req.get('x-mod-key');
    if (!provided || !secretsMatch(provided, expected)) {
      next(new HttpError(401, 'unauthorized', 'Bad or missing X-Mod-Key.'));
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

/** A query value is a string, or (for repeated params) an array. Take one. */
export function oneParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Every value of a (possibly repeated) query param, as a clean string array. */
export function manyParam(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v !== '');
  }
  return [];
}

export function parseLimit(raw: unknown, config: ApiConfig): number {
  const value = oneParam(raw);
  if (value === undefined || value === '') return config.defaultLimit;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be a positive whole number');
  }
  return Math.min(parsed, config.maxLimit);
}

export function parseCursor(raw: unknown): Cursor | undefined {
  const value = oneParam(raw);
  if (value === undefined || value === '') return undefined;
  const cursor = decodeCursor(value);
  if (!cursor) throw badRequest('cursor is not valid');
  return cursor;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseHexId(raw: string | undefined, what: string): string {
  const value = (raw ?? '').toLowerCase();
  if (!HEX64.test(value)) throw badRequest(`${what} must be 64 lowercase hex characters`);
  return value;
}

// ---------------------------------------------------------------------------
// Terminal handlers
// ---------------------------------------------------------------------------

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('No such endpoint.'));
};

/**
 * JSON error responses.
 *
 * Note what is absent: this never logs the request. No method, no path, no
 * headers, nothing about the caller (hard rule #1). Unexpected failures print
 * the error message alone, to stderr.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  process.stderr.write(`error: ${redact(err instanceof Error ? err.message : String(err))}\n`);
  res.status(500).json({ error: { code: 'internal', message: 'Something broke.' } });
}
