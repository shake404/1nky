import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbHandle } from './db.js';
import { loadFoundedCrews, saveFoundedCrew } from './crews.js';

// Fresh database per test so founded-crew records never leak between them.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
});

describe('founded-crews local store', () => {
  it('starts empty', async () => {
    expect(await loadFoundedCrews()).toEqual([]);
  });

  it('round-trips a founded crew and keeps it after a reload', async () => {
    const crew = { pubkey: 'a'.repeat(64), name: 'FASE', foundedByMe: true as const };
    await saveFoundedCrew(crew);
    expect(await loadFoundedCrews()).toEqual([crew]);

    // A reload reads the same record back out of durable storage.
    resetDbHandle();
    expect(await loadFoundedCrews()).toEqual([crew]);
  });

  it('dedupes by pubkey and never stores a secret', async () => {
    const crew = { pubkey: 'b'.repeat(64), name: 'KEMZ', foundedByMe: true as const };
    await saveFoundedCrew(crew);
    await saveFoundedCrew(crew);
    expect(await loadFoundedCrews()).toEqual([crew]);

    // The store is only a directory of pubkeys/names — no crew secret anywhere.
    const stored = await loadFoundedCrews();
    expect(stored[0]?.pubkey).toBe('b'.repeat(64));
    expect(Object.keys(stored[0]!)).toEqual(['pubkey', 'name', 'foundedByMe']);
  });
});