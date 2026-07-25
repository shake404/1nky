import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFlick,
  buildModBan,
  buildProfile,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from '@1nky/protocol';
import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, loadConfig, parseModPubkeys } from './config.js';
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

  it('has no moderators and no list exports unless told', () => {
    expect(CONFIG.modPubkeys.size).toBe(0);
    expect(CONFIG.banListExportPath).toBeUndefined();
    expect(CONFIG.invitedListExportPath).toBeUndefined();
  });

  it('reads the invited export path, treating blank as disabled', () => {
    const withPath = loadConfig({
      DATABASE_URL: 'x',
      RELAY_WS_URL: 'y',
      INVITED_LIST_EXPORT_PATH: ' /strfry-plugin/invited.json ',
    } as NodeJS.ProcessEnv);
    expect(withPath.invitedListExportPath).toBe('/strfry-plugin/invited.json');

    const blank = loadConfig({
      DATABASE_URL: 'x',
      RELAY_WS_URL: 'y',
      INVITED_LIST_EXPORT_PATH: '   ',
    } as NodeJS.ProcessEnv);
    expect(blank.invitedListExportPath).toBeUndefined();
  });

  it('reads the ban export path, treating blank as disabled', () => {
    const withPath = loadConfig({
      DATABASE_URL: 'x',
      RELAY_WS_URL: 'y',
      BAN_LIST_EXPORT_PATH: ' /strfry-plugin/banlist.json ',
    } as NodeJS.ProcessEnv);
    expect(withPath.banListExportPath).toBe('/strfry-plugin/banlist.json');

    const blank = loadConfig({
      DATABASE_URL: 'x',
      RELAY_WS_URL: 'y',
      BAN_LIST_EXPORT_PATH: '   ',
    } as NodeJS.ProcessEnv);
    expect(blank.banListExportPath).toBeUndefined();
  });

  it('parses SITE_MOD_PUBKEYS into a lowercase set', () => {
    const mod = hex('7f');
    const config = loadConfig({
      DATABASE_URL: 'x',
      RELAY_WS_URL: 'y',
      SITE_MOD_PUBKEYS: ` ${mod.toUpperCase()} , ${hex('be')}`,
    } as NodeJS.ProcessEnv);
    expect([...config.modPubkeys]).toEqual([mod, hex('be')]);
  });
});

describe('parseModPubkeys', () => {
  it('drops anything that is not a 32-byte hex pubkey', () => {
    // A truncated or malformed entry must never half-match its way into
    // moderator powers — and it is a pubkey, so it is dropped, not logged.
    expect([...parseModPubkeys('nope, 7f7f7f, , deadbeef')]).toEqual([]);
    expect([...parseModPubkeys(undefined)]).toEqual([]);
    expect([...parseModPubkeys('')]).toEqual([]);
  });

  it('dedupes across case', () => {
    const mod = hex('7f');
    expect([...parseModPubkeys(`${mod},${mod.toUpperCase()}`)]).toEqual([mod]);
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

  it('applies a moderator ban and publishes the relay ban list', async () => {
    // The whole pipeline in one test: SITE_MOD_PUBKEYS -> config -> store ->
    // banned_pubkeys -> the JSON file strfry's write policy hot-reloads.
    const dir = await mkdtemp(join(tmpdir(), '1nky-indexer-ban-'));
    const path = join(dir, 'banlist.json');
    try {
      const modSk = generateSecretKey();
      const mod = getPublicKey(modSk);
      const target = hex('be');

      const config = loadConfig({
        DATABASE_URL: 'postgres://x/y',
        RELAY_WS_URL: 'ws://relay.invalid',
        SITE_MOD_PUBKEYS: mod,
        BAN_LIST_EXPORT_PATH: path,
      } as NodeJS.ProcessEnv);

      const db = fakeDb((text) =>
        text.includes('from banned_pubkeys') && text.includes('select')
          ? { rows: [{ pubkey: target, reason: 'illegal' }], rowCount: 1 }
          : undefined,
      );
      const socket = new FakeSocket();
      const ban = finalizeEvent(
        buildModBan(target, 'ban', { reason: 'illegal', createdAt: 1_700_000_500 }),
        modSk,
      );

      const counters = await run({
        db,
        config,
        once: true,
        now: () => 1_700_000_600,
        createSocket: () => {
          queueMicrotask(() => {
            socket.emit('open');
            socket.emit('message', JSON.stringify(['EVENT', 'sub', ban]));
            socket.emit('message', JSON.stringify(['EOSE', 'sub']));
          });
          return socket;
        },
      });

      expect(counters.bans).toBe(1);
      expect(db.matching('insert into banned_pubkeys')).toHaveLength(1);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
        { pubkey: target, reason: 'illegal' },
      ]);
      expect(await readdir(dir)).toEqual(['banlist.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records a redemption and publishes the relay invited list', async () => {
    // The other half of the pipeline, end to end: a kind-0 carrying an `invite`
    // tag -> invite_edges -> the JSON file strfry's write policy hot-reloads, so
    // the writer stops paying the newcomer PoW tier within ~1s.
    const dir = await mkdtemp(join(tmpdir(), '1nky-indexer-invited-'));
    const path = join(dir, 'invited.json');
    try {
      const childSk = generateSecretKey();
      const child = getPublicKey(childSk);
      const inviter = hex('1a');
      const inviteId = 'ab12cd34ef567890';

      const config = loadConfig({
        DATABASE_URL: 'postgres://x/y',
        RELAY_WS_URL: 'ws://relay.invalid',
        INVITED_LIST_EXPORT_PATH: path,
      } as NodeJS.ProcessEnv);

      const db = fakeDb((text) =>
        text.includes('from invite_edges order by child')
          ? { rows: [{ pubkey: child }], rowCount: 1 }
          : undefined,
      );
      const socket = new FakeSocket();
      const profile = finalizeEvent(
        buildProfile({
          tag: 'NEWJACK',
          invite: { inviteId, inviterPubkey: inviter },
          createdAt: 1_700_000_500,
        }),
        childSk,
      );

      const counters = await run({
        db,
        config,
        once: true,
        now: () => 1_700_000_600,
        createSocket: () => {
          queueMicrotask(() => {
            socket.emit('open');
            socket.emit('message', JSON.stringify(['EVENT', 'sub', profile]));
            socket.emit('message', JSON.stringify(['EOSE', 'sub']));
          });
          return socket;
        },
      });

      expect(counters.putOn).toBe(1);
      expect(db.matching('update invites')).toHaveLength(1);
      expect(db.matching('insert into invite_edges')).toHaveLength(1);
      // Bare hex strings — the entry shape the write policy's loader accepts.
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([child]);
      expect(await readdir(dir)).toEqual(['invited.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
