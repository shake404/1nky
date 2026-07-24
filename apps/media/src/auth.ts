import { KINDS, verifyEvent, type SignedEvent } from '@1nky/protocol';

import { HttpError } from './errors.js';

/** Blossom BUD-11 verbs 1NKY implements. */
export type BlossomVerb = 'upload' | 'delete' | 'get' | 'list' | 'media';

/**
 * How far into the future a `created_at` may sit before we call it bogus.
 * BUD-11 says the timestamp MUST be in the past; a minute of clock skew is
 * tolerated so honest clients on a slightly fast machine still work.
 */
const CREATED_AT_SKEW_SECONDS = 60;

export interface VerifyAuthOptions {
  /** Required `t` tag value. */
  readonly verb: BlossomVerb;
  /** Unix seconds; injectable for tests. */
  readonly now?: number;
  /**
   * When set, at least one `x` tag must equal this hash. Used by DELETE, which
   * knows the target hash up front. Uploads check `x` against the body hash
   * separately (a mismatch there is a 400, not a 401).
   */
  readonly requireX?: string;
}

/** Returns every value of `name` in the event's tag list. */
export function tagValues(event: SignedEvent, name: string): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === 'string') out.push(tag[1]);
  }
  return out;
}

function firstTag(event: SignedEvent, name: string): string | undefined {
  return tagValues(event, name)[0];
}

/**
 * Decodes the `Authorization: Nostr <base64>` header.
 *
 * BUD-11 specifies base64url without padding; plenty of clients send standard
 * base64 instead, so both are accepted.
 */
function decodeAuthHeader(header: string | undefined): SignedEvent {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new HttpError(401, 'missing Authorization header');
  }
  const match = /^Nostr\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new HttpError(401, 'Authorization must use the Nostr scheme');
  }

  let json: string;
  try {
    json = Buffer.from(match[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    throw new HttpError(401, 'authorization token is not valid base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new HttpError(401, 'authorization token is not a valid event');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(401, 'authorization token is not a valid event');
  }

  const candidate = parsed as Partial<SignedEvent>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.pubkey !== 'string' ||
    typeof candidate.sig !== 'string' ||
    typeof candidate.content !== 'string' ||
    typeof candidate.kind !== 'number' ||
    typeof candidate.created_at !== 'number' ||
    !Array.isArray(candidate.tags)
  ) {
    throw new HttpError(401, 'authorization token is not a valid event');
  }

  return candidate as SignedEvent;
}

export interface VerifiedAuth {
  readonly event: SignedEvent;
  /** Hex pubkey of the signer — the only identity this service knows. */
  readonly pubkey: string;
  /** Every `x` tag on the auth event, lowercased. */
  readonly hashes: readonly string[];
}

/**
 * Verifies a Blossom BUD-11 kind-24242 authorization event.
 *
 * Every failure is a 401 — the caller has not proved anything. Semantic
 * problems with an otherwise-valid token (a body that does not hash to the
 * advertised `x`, for instance) belong to the route, not here.
 */
export function verifyBlossomAuth(
  header: string | undefined,
  options: VerifyAuthOptions,
): VerifiedAuth {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const event = decodeAuthHeader(header);

  if (event.kind !== KINDS.BLOSSOM_AUTH) {
    throw new HttpError(401, `authorization event must be kind ${KINDS.BLOSSOM_AUTH}`);
  }

  // verifyEvent also recomputes the event id, so a tampered payload fails here.
  if (!verifyEvent(event)) {
    throw new HttpError(401, 'authorization event signature is invalid');
  }

  if (event.created_at > now + CREATED_AT_SKEW_SECONDS) {
    throw new HttpError(401, 'authorization event is not yet valid');
  }

  if (firstTag(event, 't') !== options.verb) {
    throw new HttpError(401, `authorization event must carry a "t" tag of "${options.verb}"`);
  }

  const expiration = firstTag(event, 'expiration');
  if (expiration === undefined) {
    throw new HttpError(401, 'authorization event is missing an expiration tag');
  }
  const expiresAt = Number.parseInt(expiration, 10);
  if (!Number.isFinite(expiresAt)) {
    throw new HttpError(401, 'authorization event has a malformed expiration tag');
  }
  if (expiresAt <= now) {
    throw new HttpError(401, 'authorization event has expired');
  }

  const hashes = tagValues(event, 'x').map((h) => h.toLowerCase());

  if (options.requireX !== undefined && !hashes.includes(options.requireX.toLowerCase())) {
    throw new HttpError(401, 'authorization event does not cover this blob');
  }

  return { event, pubkey: event.pubkey, hashes };
}
