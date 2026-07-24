import { buildFlick, finalizeEvent, generateSecretKey } from '@1nky/protocol';
import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, loadConfig } from './config.js';
import { INDEXED_KINDS, run, startExpirationSweep } from './indexer.js';
import type { WebSocketLike } from './relay.js';
import { fakeDb, hex } from './testing/fixtures.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://x/y',
  RELAY_WS_URL: 'ws://relay.invalid',
} as NodeJS.ProcessEnv);

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
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
    this.emit('close');
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(arg);
  }
}

function signedFlick(createdAt: number) {
  return finalizeEvent(
    buildFlick({
      url: 'https://cdn.example/a.webp',
      sha256: hex('cd'),
      dims: { width: 1, height: 1 },
      createdAt,
    }),
    generateSecretKey(),
  );
}

describe('config', () => {
  it('demands the two things it cannot invent', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'x' } as NodeJS.ProcessEnv)).toThrow(/RELAY_WS_URL/);
  });

  it('defaults the sweep to 60 seconds', () => {
    expect(CONFIG.sweepIntervalMs).toBe(60_000);
  });

  it('rejects a nonsense interval rather than silently using the default', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'x',
        RELAY_WS_URL: 'y',
        SWEEP_INTERVAL_MS: 'soon',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SWEEP_INTERVAL_MS/);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and stops at the ceiling', () => {
    const full = (): number => 1;
    expect(backoffDelay(0, 1000, 30_000, full)).toBe(1000);
    expect(backoffDelay(1, 1000, 30_000, full)).toBe(2000);
    expect(backoffDelay(5, 1000, 30_000, full)).toBe(30_000);
    expect(backoffDelay(50, 1000, 30_000, full)).toBe(30_000);
  });

  it('jitters down to half the delay, never to zero', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
  });
});

describe('run', () => {
  it('replays from the stored watermark and advances it', async () => {
    const db = fakeDb((text) =>
      text.includes('select last_created_at')
        ? { rows: [{ last_created_at: '1700000000' }], rowCount: 1 }
        : undefined,
    );
    const socket = new FakeSocket();
    const event = signedFlick(1_700_000_500);

    const counters = await run({
      db,
      config: CONFIG,
      once: true,
      now: () => 1_700_000_600,
      createSocket: () => {
        // Handlers are attached synchronously after this returns.
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', JSON.stringify(['EVENT', 'sub', event]));
          socket.emit('message', JSON.stringify(['EOSE', 'sub']));
        });
        return socket;
      },
    });

    const frame: unknown = JSON.parse(socket.sent[0] as string);
    expect(frame).toEqual([
      'REQ',
      '1nky-index',
      // 300s of overlap, because relays do not guarantee created_at order.
      { kinds: [...INDEXED_KINDS], since: 1_700_000_000 - 300 },
    ]);
    expect(counters.events).toBe(1);
    expect(counters.flicks).toBe(1);

    const watermark = db.matching('insert into sync_state').at(-1);
    expect(watermark?.params).toEqual(['relay', 1_700_000_500]);
  });

  it('counts an indexing failure instead of dying', async () => {
    const db = fakeDb((text) => {
      if (text.includes('insert into events')) throw new Error('deadlock detected');
      return undefined;
    });
    const socket = new FakeSocket();

    const counters = await run({
      db,
      config: CONFIG,
      once: true,
      createSocket: () => {
        queueMicrotask(() => {
          socket.emit('open');
          socket.emit('message', JSON.stringify(['EVENT', 'sub', signedFlick(1_700_000_500)]));
          socket.emit('message', JSON.stringify(['EOSE', 'sub']));
        });
        return socket;
      },
    });
    expect(counters.errors).toBe(1);
    expect(counters.events).toBe(0);
  });

  it('retries with backoff when the relay is down', async () => {
    const db = fakeDb();
    const slept: number[] = [];
    const counters = await run({
      db,
      config: CONFIG,
      maxAttempts: 3,
      createSocket: () => {
        const socket = new FakeSocket();
        queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')));
        return socket;
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(counters.events).toBe(0);
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(0);
  });
});

describe('startExpirationSweep', () => {
  it('runs on the configured interval and stops when told', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb(() => ({ rows: [], rowCount: 0 }));
      const stop = startExpirationSweep(db, 60_000, () => 1_700_000_000);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(db.matching('delete from events')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(db.matching('delete from events')).toHaveLength(2);

      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(db.matching('delete from events')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
