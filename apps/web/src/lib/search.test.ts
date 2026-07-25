import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The search screen reads one answer with four lists in it, and every one of
 * them is allowed to be absent — an older box answers with walls and flicks
 * only, and the screen still has to work. The other thing pinned here is that
 * search is not a hole in the mute list: somebody you are ignoring must not come
 * back just because you typed their city.
 */

// mute.ts reaches publish.ts, which touches the relay singleton on import.
vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(async () => ({ id: 'x'.repeat(64) })),
}));

const search = await import('./search.js');
const { resetDbHandle, setPref } = await import('./db.js');
const mute = await import('./mute.js');
const { API_BASE } = await import('./config.js');

const NOW = 1_800_000_000;

const shock = 'a'.repeat(64);
const rask = 'b'.repeat(64);

function flickRow(id: string, pubkey: string, caption: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    url: `https://media.example/${id}.webp`,
    sha256: 'f'.repeat(64),
    writer: { pubkey, tag: 'SHOCK' },
    createdAt,
    width: 900,
    height: 1200,
    caption,
  };
}

function clipRow(id: string, pubkey: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    url: `https://media.example/${id}.mp4`,
    sha256: 'e'.repeat(64),
    writer: { pubkey, tag: 'RASK' },
    createdAt,
    width: 1280,
    height: 720,
    caption: 'rolling',
    posterUrl: 'https://media.example/poster.webp',
    duration: 14,
  };
}

function threadRow(id: string, pubkey: string): Record<string, unknown> {
  return {
    id,
    subject: 'Who buffed the yard',
    excerpt: 'somebody rolled the whole thing',
    writer: { pubkey, tag: 'SHOCK', mark: 'aa11bb', avatarSha256: null },
    createdAt: NOW - 3600,
    expiresAt: null,
    replyCount: 2,
  };
}

const FULL = {
  q: 'sf',
  boards: ['sf-bay', 'oakland'],
  flicks: [flickRow('1'.repeat(64), shock, 'rooftop', NOW - 500)],
  videos: [clipRow('2'.repeat(64), rask, NOW - 100)],
  threads: [threadRow('3'.repeat(64), shock)],
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  mute.resetIgnoredCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSearchResponse', () => {
  it('reads all four lists', () => {
    const results = search.parseSearchResponse(FULL);

    expect(results.q).toBe('sf');
    expect(results.boards).toEqual(['sf-bay', 'oakland']);
    expect(results.media).toHaveLength(2);
    expect(results.threads.map((t) => t.id)).toEqual(['3'.repeat(64)]);
    expect(search.isEmpty(results)).toBe(false);
  });

  it('puts flicks and clips on one wall, newest first', () => {
    const results = search.parseSearchResponse(FULL);
    expect(results.media.map((m) => m.id)).toEqual(['2'.repeat(64), '1'.repeat(64)]);
    expect(results.media[0]?.mediaType).toBe('video');
    expect(results.media[1]?.mediaType).toBe('flick');
  });

  it('knows a clip from the list it arrived in, even unlabelled', () => {
    const unlabelled = clipRow('4'.repeat(64), rask, NOW);
    delete unlabelled['mediaType'];
    const results = search.parseSearchResponse({ q: 'x', videos: [unlabelled] });
    expect(results.media[0]?.mediaType).toBe('video');
    expect(results.media[0]?.duration).toBe(14);
  });

  it('is fine with an older box that sends no clips and no talk at all', () => {
    const results = search.parseSearchResponse({ q: 'sf', boards: ['sf-bay'], flicks: FULL.flicks });

    expect(results.media).toHaveLength(1);
    expect(results.threads).toEqual([]);
    expect(results.boards).toEqual(['sf-bay']);
  });

  it('is fine with an answer that has nothing in it at all', () => {
    for (const payload of [{}, null, undefined, [], 'nope', { boards: 'sf', flicks: 7, threads: {} }]) {
      const results = search.parseSearchResponse(payload);
      expect(results.boards).toEqual([]);
      expect(results.media).toEqual([]);
      expect(results.threads).toEqual([]);
      expect(search.isEmpty(results)).toBe(true);
    }
  });

  it('takes a wall named as a row, and never lists the same one twice', () => {
    const results = search.parseSearchResponse({
      boards: ['sf-bay', { slug: 'SF-BAY' }, { slug: 'oakland' }, '', { nothing: true }],
    });
    expect(results.boards).toEqual(['sf-bay', 'oakland']);
  });

  it('drops the same post arriving in both lists', () => {
    const both = { q: 'x', flicks: [flickRow('9'.repeat(64), shock, 'twice', NOW)], videos: [flickRow('9'.repeat(64), shock, 'twice', NOW)] };
    expect(search.parseSearchResponse(both).media).toHaveLength(1);
  });

  it('keeps a writer you are ignoring out of both the wall and the talk', async () => {
    await setPref('ignored-writers', [shock]);
    await mute.loadIgnored();

    const results = search.parseSearchResponse(FULL);

    expect(results.media.map((m) => m.id)).toEqual(['2'.repeat(64)]);
    expect(results.threads).toEqual([]);
  });

  it('lifts a flat writer id on a thread row into the shape a row needs', () => {
    const flat = { id: '5'.repeat(64), subject: 'flat', excerpt: 'older box', writer: shock, createdAt: NOW, replyCount: 0 };
    const results = search.parseSearchResponse({ threads: [flat] });
    expect(results.threads[0]?.writer.pubkey).toBe(shock);
  });
});

describe('searchUrl', () => {
  it('asks for the query and a ceiling on how much comes back', () => {
    const url = new URL(search.searchUrl('sf bay'));
    expect(url.origin + url.pathname).toBe(`${API_BASE}/search`);
    expect(url.searchParams.get('q')).toBe('sf bay');
    expect(url.searchParams.get('limit')).toBe(String(search.SEARCH_LIMIT));
    expect(new URL(search.searchUrl('sf', 5)).searchParams.get('limit')).toBe('5');
  });
});

describe('fetchSearch', () => {
  it('reads the wall’s answer', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => FULL } as unknown as Response);

    const results = await search.fetchSearch('sf');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/search?q=sf');
    expect(results.boards).toEqual(['sf-bay', 'oakland']);
  });

  it('gives up rather than inventing an answer when the wall is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    await expect(search.fetchSearch('sf')).rejects.toThrow();
  });
});
