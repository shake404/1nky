import { buildFlick, finalizeEvent, generateSecretKey, type SignedEvent } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import { INDEXED_KINDS } from './indexer.js';
import { looksLikeEvent, parseMessage, reqFrame, runConnection, type WebSocketLike } from './relay.js';
import { hex } from './testing/fixtures.js';

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>();

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (arg?: unknown) => void);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(arg);
  }
}

function signedFlick(): SignedEvent {
  const sk = generateSecretKey();
  return finalizeEvent(
    buildFlick({ url: 'https://cdn.example/a.webp', sha256: hex('cd'), dims: { width: 1, height: 1 } }),
    sk,
  );
}

describe('reqFrame', () => {
  it('asks for every indexed kind since the watermark', () => {
    const frame: unknown = JSON.parse(reqFrame({ kinds: INDEXED_KINDS, since: 42 }));
    expect(frame).toEqual(['REQ', '1nky-index', { kinds: [...INDEXED_KINDS], since: 42 }]);
  });

  it('does not index Blossom upload credentials', () => {
    expect(INDEXED_KINDS).not.toContain(24242);
    expect(INDEXED_KINDS).toContain(20);
  });

  it('never subscribes to gift wraps — private messages stay in the relay', () => {
    // Asking for kind 1059 at all would pull every private message on the site
    // through this process. The index is served by a public read API; wraps
    // are fetched by their own recipient, from the relay, with a `#p` filter.
    expect(INDEXED_KINDS).not.toContain(1059);
    expect(reqFrame({ kinds: INDEXED_KINDS, since: 0 })).not.toContain('1059');
  });
});

describe('parseMessage', () => {
  it('accepts strings and buffers', () => {
    expect(parseMessage('["EOSE","x"]')).toEqual(['EOSE', 'x']);
    expect(parseMessage(Buffer.from('["EOSE","x"]'))).toEqual(['EOSE', 'x']);
  });

  it('rejects junk', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('{"a":1}')).toBeNull();
    expect(parseMessage('[1,2]')).toBeNull();
    expect(parseMessage(42)).toBeNull();
  });
});

describe('looksLikeEvent', () => {
  it('requires the full envelope', () => {
    expect(looksLikeEvent(signedFlick())).toBe(true);
    expect(looksLikeEvent({ id: 'x' })).toBe(false);
    expect(looksLikeEvent(null)).toBe(false);
  });
});

describe('runConnection', () => {
  it('sends a REQ on open and delivers verified events in order', async () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    const first = signedFlick();
    const second = signedFlick();

    const done = runConnection({
      url: 'ws://relay.invalid',
      filter: { kinds: [20], since: 0 },
      createSocket: () => socket,
      onEvent: async (event) => {
        seen.push(event.id);
      },
    });

    socket.emit('open');
    expect(socket.sent).toHaveLength(1);
    socket.emit('message', JSON.stringify(['EVENT', 'sub', first]));
    socket.emit('message', JSON.stringify(['EVENT', 'sub', second]));
    socket.emit('message', JSON.stringify(['EOSE', 'sub']));
    socket.close();

    await expect(done).resolves.toBe(true);
    expect(seen).toEqual([first.id, second.id]);
  });

  it('drops events whose signature does not verify', async () => {
    const socket = new FakeSocket();
    let invalid = 0;
    const seen: string[] = [];
    const tampered = { ...signedFlick(), content: 'not what was signed' };

    const done = runConnection({
      url: 'ws://relay.invalid',
      filter: {},
      createSocket: () => socket,
      onEvent: async (event) => {
        seen.push(event.id);
      },
      onInvalid: () => {
        invalid += 1;
      },
    });

    socket.emit('open');
    socket.emit('message', JSON.stringify(['EVENT', 'sub', tampered]));
    socket.emit('message', JSON.stringify(['EVENT', 'sub', { id: 'short' }]));
    socket.close();

    await done;
    expect(seen).toEqual([]);
    expect(invalid).toBe(2);
  });

  it('closes itself after EOSE in rebuild mode', async () => {
    const socket = new FakeSocket();
    let eose = 0;

    const done = runConnection({
      url: 'ws://relay.invalid',
      filter: {},
      createSocket: () => socket,
      onEvent: async () => undefined,
      onEose: () => {
        eose += 1;
      },
      stopAfterEose: true,
    });

    socket.emit('open');
    socket.emit('message', JSON.stringify(['EOSE', 'sub']));

    await expect(done).resolves.toBe(true);
    expect(eose).toBe(1);
    expect(socket.closed).toBe(true);
  });

  it('reports a socket error without ever having opened', async () => {
    const socket = new FakeSocket();
    let message = '';

    const done = runConnection({
      url: 'ws://relay.invalid',
      filter: {},
      createSocket: () => socket,
      onEvent: async () => undefined,
      onSocketError: (err) => {
        message = err.message;
      },
    });

    socket.emit('error', new Error('ECONNREFUSED'));
    await expect(done).resolves.toBe(false);
    expect(message).toBe('ECONNREFUSED');
  });
});
