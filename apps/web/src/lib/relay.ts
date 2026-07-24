import type { SignedEvent } from '@1nky/protocol';
import { RELAY_WS_URL } from './config.js';

/**
 * Thin WebSocket wrapper for the write path.
 *
 * Deliberately not `nostr-tools`' pool: we talk to exactly one endpoint, we
 * need precise control over reconnect behaviour on flaky phone networks, and
 * we want zero surprise traffic to anywhere else.
 */

export interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tagQuery: `#${string}`]: string[] | number | undefined;
}

export interface SubscriptionHandlers {
  onEvent?: (event: SignedEvent) => void;
  /** Fired once the endpoint has sent everything it had stored. */
  onEnd?: () => void;
  onNotice?: (message: string) => void;
}

export interface Subscription {
  id: string;
  close: () => void;
}

export interface PublishResult {
  accepted: boolean;
  /** Raw message from the far end. Never shown to a writer verbatim. */
  message: string;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

type Pending = { resolve: (r: PublishResult) => void; timer: ReturnType<typeof setTimeout> };

const PUBLISH_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;

export class RelayClient {
  readonly url: string;

  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private outbox: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly subs = new Map<string, { filters: Filter[]; handlers: SubscriptionHandlers }>();
  private readonly watchers = new Set<(state: ConnectionState) => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private counter = 0;

  constructor(url: string = RELAY_WS_URL) {
    this.url = url;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  watch(fn: (state: ConnectionState) => void): () => void {
    this.watchers.add(fn);
    fn(this.state);
    return () => this.watchers.delete(fn);
  }

  connect(): void {
    if (this.socket && (this.state === 'open' || this.state === 'connecting')) return;
    if (typeof WebSocket === 'undefined') return;
    this.closedByUs = false;
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      for (const [id, sub] of this.subs) this.send(['REQ', id, ...sub.filters]);
      const queued = this.outbox;
      this.outbox = [];
      for (const frame of queued) socket.send(frame);
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      this.handle(ev.data);
    };

    socket.onerror = () => {
      /* Errors surface as a close; nothing about the connection is logged. */
    };

    socket.onclose = () => {
      this.socket = null;
      this.setState('closed');
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  /** Publish a signed event and wait for the endpoint's verdict. */
  publish(event: SignedEvent, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<PublishResult> {
    this.connect();
    return new Promise<PublishResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(event.id);
        resolve({ accepted: false, message: 'timeout' });
      }, timeoutMs);
      this.pending.set(event.id, { resolve, timer });
      this.send(['EVENT', event]);
    });
  }

  subscribe(filters: Filter[], handlers: SubscriptionHandlers): Subscription {
    this.connect();
    const id = `s${(this.counter += 1).toString(36)}${Date.now().toString(36)}`;
    this.subs.set(id, { filters, handlers });
    this.send(['REQ', id, ...filters]);
    return {
      id,
      close: () => {
        if (!this.subs.delete(id)) return;
        this.send(['CLOSE', id]);
      },
    };
  }

  /** Collect stored events matching a filter, then hang up. */
  query(filters: Filter[], timeoutMs = 8000): Promise<SignedEvent[]> {
    return new Promise<SignedEvent[]>((resolve) => {
      const found: SignedEvent[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve(found);
      };
      const timer = setTimeout(finish, timeoutMs);
      const sub = this.subscribe(filters, {
        onEvent: (event) => found.push(event),
        onEnd: finish,
      });
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  // --- internals ------------------------------------------------------------

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const watcher of this.watchers) watcher(state);
  }

  private send(frame: unknown[]): void {
    const text = JSON.stringify(frame);
    if (this.socket && this.state === 'open') {
      this.socket.send(text);
      return;
    }
    // Never queue REQ/CLOSE: subscriptions are replayed wholesale on open.
    if (frame[0] === 'EVENT') this.outbox.push(text);
    this.connect();
  }

  private handle(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return;

    switch (frame[0]) {
      case 'EVENT': {
        const id = frame[1];
        const event = frame[2] as SignedEvent | undefined;
        if (typeof id !== 'string' || !event) return;
        this.subs.get(id)?.handlers.onEvent?.(event);
        return;
      }
      case 'EOSE': {
        const id = frame[1];
        if (typeof id !== 'string') return;
        this.subs.get(id)?.handlers.onEnd?.();
        return;
      }
      case 'OK': {
        const id = frame[1];
        if (typeof id !== 'string') return;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve({
          accepted: frame[2] === true,
          message: typeof frame[3] === 'string' ? frame[3] : '',
        });
        return;
      }
      case 'CLOSED': {
        const id = frame[1];
        if (typeof id !== 'string') return;
        const sub = this.subs.get(id);
        this.subs.delete(id);
        sub?.handlers.onEnd?.();
        return;
      }
      case 'NOTICE': {
        const message = typeof frame[1] === 'string' ? frame[1] : '';
        for (const sub of this.subs.values()) sub.handlers.onNotice?.(message);
        return;
      }
      default:
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempt, 5));
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** The app's single connection. */
export const relay = new RelayClient();
