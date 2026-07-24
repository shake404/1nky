import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

import { buildFlick, finalizeEvent, generateSecretKey } from '@1nky/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { loadConfig } from './config.js';
import { run } from './indexer.js';
import { fakeDb, hex } from './testing/fixtures.js';

/**
 * The one path a fake socket cannot cover: the real `ws` client talking to a
 * real websocket server over loopback.
 *
 * This is not an integration test against strfry — it is an in-process relay
 * that speaks just enough of NIP-01 to prove the client connects, sends a
 * well-formed REQ, and consumes EVENT/EOSE frames. No Docker, no network.
 */
describe('the real websocket client', () => {
  let server: WebSocketServer;
  let url: string;
  const received: unknown[] = [];

  const sk = generateSecretKey();
  const event = finalizeEvent(
    buildFlick({
      url: 'https://cdn.example/a.webp',
      sha256: hex('cd'),
      dims: { width: 10, height: 20 },
      caption: 'live wire',
      createdAt: 1_700_000_500,
    }),
    sk,
  );

  beforeAll(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    server.on('connection', (socket) => {
      socket.on('message', (data: Buffer) => {
        const frame: unknown = JSON.parse(data.toString('utf8'));
        received.push(frame);
        const subscriptionId = Array.isArray(frame) ? String(frame[1]) : 'sub';
        socket.send(JSON.stringify(['EVENT', subscriptionId, event]));
        socket.send(JSON.stringify(['EVENT', subscriptionId, { ...event, content: 'forged' }]));
        socket.send(JSON.stringify(['EOSE', subscriptionId]));
      });
    });
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  it('subscribes, verifies and indexes over a real socket', async () => {
    const db = fakeDb();
    const config = loadConfig({
      DATABASE_URL: 'postgres://x/y',
      RELAY_WS_URL: url,
    } as NodeJS.ProcessEnv);

    const counters = await run({ db, config, once: true, now: () => 1_700_000_600 });

    expect(counters.connections).toBe(1);
    expect(counters.events).toBe(1);
    expect(counters.flicks).toBe(1);
    // The tampered copy of the same event never reaches Postgres.
    expect(counters.invalid).toBe(1);

    const req = received[0] as [string, string, Record<string, unknown>];
    expect(req[0]).toBe('REQ');
    expect(req[2]['kinds']).toContain(20);
  });

  it('reports the relay as unreachable rather than hanging', async () => {
    const db = fakeDb();
    const config = loadConfig({
      DATABASE_URL: 'postgres://x/y',
      // Port 1 on loopback: nothing listens there.
      RELAY_WS_URL: 'ws://127.0.0.1:1',
    } as NodeJS.ProcessEnv);

    const counters = await run({
      db,
      config,
      once: true,
      maxAttempts: 2,
      sleep: async () => undefined,
    });

    expect(counters.connections).toBe(0);
    expect(counters.events).toBe(0);
  });
});
