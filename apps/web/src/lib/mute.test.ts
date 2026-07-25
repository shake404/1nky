import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ignored-writers list.
 *
 * Two contracts matter here and both are easy to break by accident:
 *   1. the device list is written BEFORE anything goes up, so ignoring works
 *      with no connection at all; and
 *   2. every change publishes the WHOLE list, because a kind-10000 replaces
 *      its predecessor — publishing only the delta would silently un-ignore
 *      everyone else.
 */

const published: { template: { kind: number; tags: string[][] }; bits: number }[] = [];

vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(
    async (
      _secret: Uint8Array,
      _pubkey: string,
      template: { kind: number; tags: string[][] },
      bits: number,
    ) => {
      published.push({ template, bits });
      return { id: 'x'.repeat(64) };
    },
  ),
}));

const mute = await import('./mute.js');
const { resetDbHandle, getPref } = await import('./db.js');
const { KINDS } = await import('@1nky/protocol');
const { POW_BITS } = await import('./config.js');

const me = { secret: new Uint8Array(32).fill(7), pubkey: 'f'.repeat(64) };
const alpha = 'a'.repeat(64);
const beta = 'b'.repeat(64);

function pTags(index: number): string[] {
  return (published[index]?.template.tags ?? []).filter((t) => t[0] === 'p').map((t) => t[1] ?? '');
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  mute.resetIgnoredCache();
  published.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ignoreWriter', () => {
  it('adds a writer, persists them, and answers isIgnored synchronously', async () => {
    await mute.ignoreWriter(me, alpha);

    expect(mute.isIgnored(alpha)).toBe(true);
    expect(mute.ignoredWriters()).toEqual([alpha]);
    expect(await getPref<string[]>('ignored-writers', [])).toEqual([alpha]);
  });

  it('survives a reload: loadIgnored primes the synchronous mirror from storage', async () => {
    await mute.ignoreWriter(me, alpha);

    // A fresh launch — the mirror is empty until it is primed.
    mute.resetIgnoredCache();
    expect(mute.isIgnored(alpha)).toBe(false);
    expect(mute.ignoredReady()).toBe(false);

    expect(await mute.loadIgnored()).toEqual([alpha]);
    expect(mute.ignoredReady()).toBe(true);
    expect(mute.isIgnored(alpha)).toBe(true);
  });

  it('publishes the WHOLE list, not a delta, at the cheap tier', async () => {
    await mute.ignoreWriter(me, alpha);
    await mute.ignoreWriter(me, beta);

    expect(published).toHaveLength(2);
    expect(pTags(0)).toEqual([alpha]);
    expect(pTags(1)).toEqual([alpha, beta]);
    expect(published[0]?.template.kind).toBe(KINDS.MUTE_LIST);
    expect(published[0]?.bits).toBe(POW_BITS.reaction);
  });

  it('is idempotent — ignoring twice does not double the list or re-publish', async () => {
    await mute.ignoreWriter(me, alpha);
    await mute.ignoreWriter(me, alpha);

    expect(mute.ignoredWriters()).toEqual([alpha]);
    expect(published).toHaveLength(1);
  });

  it('refuses to ignore yourself', async () => {
    await mute.ignoreWriter(me, me.pubkey);

    expect(mute.ignoredWriters()).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it('keeps the writer ignored on this device even when it could not go up', async () => {
    const publish = vi.mocked((await import('./publish.js')).publishTemplate);
    publish.mockRejectedValueOnce(new Error('That did not go up.'));

    await expect(mute.ignoreWriter(me, alpha)).rejects.toThrow(/did not go up/);

    expect(mute.isIgnored(alpha)).toBe(true);
    expect(await getPref<string[]>('ignored-writers', [])).toEqual([alpha]);
  });
});

describe('stopIgnoring', () => {
  it('removes one writer and re-publishes what is left', async () => {
    await mute.ignoreWriter(me, alpha);
    await mute.ignoreWriter(me, beta);
    published.length = 0;

    await mute.stopIgnoring(me, alpha);

    expect(mute.ignoredWriters()).toEqual([beta]);
    expect(mute.isIgnored(alpha)).toBe(false);
    expect(pTags(0)).toEqual([beta]);
  });

  it('publishes an empty list when the last writer comes off', async () => {
    await mute.ignoreWriter(me, alpha);
    published.length = 0;

    await mute.stopIgnoring(me, alpha);

    expect(published).toHaveLength(1);
    expect(pTags(0)).toEqual([]);
    expect(await getPref<string[]>('ignored-writers', [])).toEqual([]);
  });

  it('does nothing for somebody who was never on the list', async () => {
    await mute.stopIgnoring(me, alpha);
    expect(published).toHaveLength(0);
  });
});

describe('the wall obeys the list', () => {
  it('drops an ignored writer where feed rows are shaped, so every wall is covered', async () => {
    const { parseFeedResponse } = await import('./feed.js');
    const body = {
      items: [
        row('1'.repeat(64), alpha),
        row('2'.repeat(64), beta),
      ],
    };

    expect(parseFeedResponse(body).flicks).toHaveLength(2);

    await mute.ignoreWriter(me, alpha);

    const after = parseFeedResponse(body).flicks;
    expect(after).toHaveLength(1);
    expect(after[0]?.pubkey).toBe(beta);
  });
});

function row(id: string, pubkey: string): Record<string, unknown> {
  return {
    id,
    pubkey,
    createdAt: 1_700_000_000,
    url: 'https://media.example/x',
    sha256: 'c'.repeat(64),
    width: 100,
    height: 100,
    caption: '',
  };
}

describe('subscribeIgnored', () => {
  it('tells an open screen about every change', async () => {
    const seen: readonly string[][] = [];
    const listener = vi.fn((list: readonly string[]) => {
      (seen as string[][]).push([...list]);
    });
    const off = mute.subscribeIgnored(listener);

    await mute.ignoreWriter(me, alpha);
    await mute.stopIgnoring(me, alpha);
    off();
    await mute.ignoreWriter(me, beta);

    expect(seen).toEqual([[alpha], []]);
  });
});
