import WebSocket from 'ws';

import { type SignedEvent, verifyEvent } from '@1nky/protocol';

/**
 * The strfry firehose client.
 *
 * Connection handling only — it knows nothing about Postgres. Events are
 * signature-checked here and handed to `onEvent`; anything that fails
 * verification is dropped and counted.
 *
 * NOTHING about the connection is ever logged. Not the URL, not a peer, not a
 * subscription id. Callers get counts.
 */

export type RelayMessage = [string, ...unknown[]];

export interface RelayFilter {
  kinds?: readonly number[];
  since?: number;
  limit?: number;
}

export interface RelayClientOptions {
  url: string;
  filter: RelayFilter;
  /** Called for each signature-verified event, in arrival order. */
  onEvent: (event: SignedEvent) => Promise<void>;
  /** Called once the relay signals end-of-stored-events. */
  onEose?: () => Promise<void> | void;
  /** Signature verification failed. The event is already dropped. */
  onInvalid?: () => void;
  /** Close the socket after EOSE instead of following the live stream. */
  stopAfterEose?: boolean;
  /** Socket-level failure. Message only — never connection details. */
  onSocketError?: (err: Error) => void;
  /** Injected for tests. */
  createSocket?: (url: string) => WebSocketLike;
}

/** The slice of `ws` used here, so tests can substitute a fake socket. */
export interface WebSocketLike {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export const SUBSCRIPTION_ID = '1nky-index';

/** Builds the REQ frame. Pure — asserted in tests. */
export function reqFrame(filter: RelayFilter, subscriptionId = SUBSCRIPTION_ID): string {
  const body: Record<string, unknown> = {};
  if (filter.kinds) body['kinds'] = [...filter.kinds];
  if (filter.since !== undefined) body['since'] = filter.since;
  if (filter.limit !== undefined) body['limit'] = filter.limit;
  return JSON.stringify(['REQ', subscriptionId, body]);
}

/** Parses a relay frame. Returns null for anything unparseable. */
export function parseMessage(data: unknown): RelayMessage | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof Uint8Array) text = Buffer.from(data).toString('utf8');
  else if (Buffer.isBuffer(data)) text = data.toString('utf8');
  else return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return null;
    return parsed as RelayMessage;
  } catch {
    return null;
  }
}

/** Shape check before the (expensive) signature check. */
export function looksLikeEvent(value: unknown): value is SignedEvent {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['sig'] === 'string' &&
    typeof e['kind'] === 'number' &&
    typeof e['created_at'] === 'number' &&
    typeof e['content'] === 'string' &&
    Array.isArray(e['tags'])
  );
}

/**
 * Runs one connection to completion. Resolves when the socket closes (or
 * after EOSE when `stopAfterEose` is set) with whether the socket ever
 * opened, which is what the caller uses to decide whether to reset backoff.
 * Never rejects: a dead relay is an expected state, not an exception.
 */
export function runConnection(options: RelayClientOptions): Promise<boolean> {
  const create = options.createSocket ?? ((url: string) => new WebSocket(url) as WebSocketLike);
  const socket = create(options.url);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let opened = false;
    // Events are applied strictly in order: a buff must not overtake the
    // event it deletes.
    let chain: Promise<void> = Promise.resolve();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };

    socket.on('open', () => {
      opened = true;
      socket.send(reqFrame(options.filter));
    });

    socket.on('message', (data: unknown) => {
      const message = parseMessage(data);
      if (!message) return;

      if (message[0] === 'EVENT') {
        const candidate = message[2];
        if (!looksLikeEvent(candidate)) {
          options.onInvalid?.();
          return;
        }
        if (!verifyEvent(candidate)) {
          options.onInvalid?.();
          return;
        }
        chain = chain.then(() => options.onEvent(candidate));
        return;
      }

      if (message[0] === 'EOSE') {
        chain = chain.then(async () => {
          await options.onEose?.();
          if (options.stopAfterEose) socket.close();
        });
        return;
      }

      if (message[0] === 'CLOSED') {
        socket.close();
      }
    });

    socket.on('error', (err: Error) => {
      options.onSocketError?.(err);
      finish();
    });

    socket.on('close', () => {
      chain.then(
        () => finish(),
        () => finish(),
      );
    });
  });
}
