import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shout-outs — the times somebody said your name.
 *
 * Three things are worth pinning and nothing else is: the shaping (a row with
 * nowhere to go is not a row, and an ignored writer cannot shout at you), the
 * last-looked stamp (it lives on the device, it only ever moves forwards, and
 * it is what "new" means), and the link — a shout under a picture and a shout
 * in a thread go to two different screens.
 */

vi.mock('./mute.js', () => ({
  isIgnored: (pubkey: string) => pubkey === 'c'.repeat(64),
}));

const {
  countNew,
  fetchShouts,
  loadShoutsSeen,
  markShoutsSeen,
  parseShoutsResponse,
  placeText,
  resetShoutsSeenCache,
  shoutLink,
  shoutsSeenAt,
  shoutsSeenReady,
  subscribeShoutsSeen,
  unseenShoutCount,
} = await import('./shoutouts.js');
const { resetDbHandle, getPref } = await import('./db.js');

const ID = (char: string): string => char.repeat(64);
const ME = ID('7');

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID('a'),
    createdAt: 1_700_000_100,
    content: 'ask @KILO, he was there',
    writer: { pubkey: ID('b'), tag: 'SMOG' },
    where: { id: ID('1'), type: 'flick', subject: null, excerpt: 'rooftop' },
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  resetShoutsSeenCache();
  vi.restoreAllMocks();
});

describe('parseShoutsResponse', () => {
  it('reads who said it, what they said and where', () => {
    const page = parseShoutsResponse({ mentions: [row()], nextCursor: 'next' });

    expect(page.cursor).toBe('next');
    expect(page.shouts).toHaveLength(1);
    const first = page.shouts[0]!;
    expect(first.id).toBe(ID('a'));
    expect(first.content).toBe('ask @KILO, he was there');
    expect(first.writer.tag).toBe('SMOG');
    // The mark is derived from the writer, so it is always there.
    expect(first.writer.mark).toHaveLength(6);
    expect(first.where).toEqual({ id: ID('1'), type: 'flick', subject: null, excerpt: 'rooftop' });
  });

  it('tells a reply apart from being put on a post', () => {
    // A writer can add your name to their own flick after it is up ("Add to
    // this"). There is nothing to quote, so the row has to know which it is.
    expect(parseShoutsResponse({ mentions: [row()] }).shouts[0]?.source).toBe('reply');
    const tagged = parseShoutsResponse({
      mentions: [row({ source: 'tag', content: '' })],
    }).shouts[0];
    expect(tagged?.source).toBe('tag');
    expect(tagged?.content).toBe('');
    // Anything unfamiliar reads as a reply, which is what every row used to be.
    expect(parseShoutsResponse({ mentions: [row({ source: 'whatever' })] }).shouts[0]?.source).toBe(
      'reply',
    );
  });

  it('throws out a row with nowhere to go', () => {
    const page = parseShoutsResponse({
      mentions: [
        row({ id: ID('a'), where: { id: 'nope', type: 'flick' } }),
        row({ id: ID('d'), where: null }),
        row({ id: ID('e') }),
      ],
    });

    expect(page.shouts.map((s) => s.id)).toEqual([ID('e')]);
  });

  it('drops a shout from somebody you ignore', () => {
    const page = parseShoutsResponse({
      mentions: [row({ id: ID('e'), writer: { pubkey: ID('c') } }), row({ id: ID('f') })],
    });

    expect(page.shouts.map((s) => s.id)).toEqual([ID('f')]);
  });

  it('defaults a place the wall could not name', () => {
    const page = parseShoutsResponse({
      mentions: [row({ where: { id: ID('1'), type: '', subject: '  ', excerpt: '' } })],
    });
    expect(page.shouts[0]?.where.type).toBe('post');
    expect(page.shouts[0]?.where.subject).toBeNull();
  });

  it('reads junk as an empty list rather than throwing', () => {
    expect(parseShoutsResponse(null)).toEqual({ shouts: [], cursor: null });
    expect(parseShoutsResponse({ mentions: 'nope' })).toEqual({ shouts: [], cursor: null });
    expect(parseShoutsResponse({ mentions: [row()] }).cursor).toBeNull();
  });
});

describe('fetchShouts', () => {
  it('asks for this writer, a page at a time', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ mentions: [row()] }) } as Response;
    }) as unknown as typeof globalThis.fetch);

    const page = await fetchShouts(ME, { cursor: 'abc', limit: 10 });

    expect(page.shouts).toHaveLength(1);
    expect(seen[0]).toContain(`/mentions/${ME}?`);
    expect(seen[0]).toContain('limit=10');
    expect(seen[0]).toContain('cursor=abc');
  });

  it('throws when the wall is unreachable, rather than showing an empty inbox', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(fetchShouts(ME)).rejects.toThrow();
  });
});

describe('where a shout-out goes', () => {
  it('sends a thread shout to the thread and everything else to the picture', () => {
    expect(shoutLink({ id: ID('1'), type: 'thread', subject: null, excerpt: '' })).toBe(
      `/t/${ID('1')}`,
    );
    expect(shoutLink({ id: ID('1'), type: 'flick', subject: null, excerpt: '' })).toBe(
      `/f/${ID('1')}`,
    );
    // A clip lives on the same screen a flick does.
    expect(shoutLink({ id: ID('1'), type: 'video', subject: null, excerpt: '' })).toBe(
      `/f/${ID('1')}`,
    );
  });

  it('names the place with the title, the first line, or a plain word', () => {
    expect(placeText({ id: ID('1'), type: 'thread', subject: 'Alameda wall', excerpt: 'x' })).toBe(
      'Alameda wall',
    );
    expect(placeText({ id: ID('1'), type: 'flick', subject: null, excerpt: 'rooftop\nmore' })).toBe(
      'rooftop',
    );
    expect(placeText({ id: ID('1'), type: 'thread', subject: null, excerpt: '' })).toBe('a thread');
    expect(placeText({ id: ID('1'), type: 'flick', subject: null, excerpt: '' })).toBe('a flick');
  });

  it('cuts a very long title rather than letting it run', () => {
    const text = placeText({ id: ID('1'), type: 'thread', subject: 'x'.repeat(200), excerpt: '' });
    expect(text).toHaveLength(60);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('the last-looked stamp', () => {
  it('starts at nothing, so a first visit shows everything as new', async () => {
    expect(shoutsSeenReady()).toBe(false);
    expect(await loadShoutsSeen()).toBe(0);
    expect(shoutsSeenReady()).toBe(true);
  });

  it('stays on the device and answers synchronously after one read', async () => {
    await markShoutsSeen(1_700_000_500);
    expect(shoutsSeenAt()).toBe(1_700_000_500);

    // A fresh session reads it back out of the device store.
    resetShoutsSeenCache();
    expect(await loadShoutsSeen()).toBe(1_700_000_500);
    expect(await getPref<number>('shouts-seen', 0)).toBe(1_700_000_500);
  });

  it('only ever moves forwards', async () => {
    await markShoutsSeen(1_700_000_500);
    await markShoutsSeen(1_700_000_100);
    expect(shoutsSeenAt()).toBe(1_700_000_500);
  });

  it('tells the top bar the moment it moves', async () => {
    const seen: number[] = [];
    const stop = subscribeShoutsSeen((at) => seen.push(at));
    await markShoutsSeen(1_700_000_500);
    stop();
    await markShoutsSeen(1_700_000_900);
    expect(seen).toEqual([1_700_000_500]);
  });

  it('counts what landed after the last look', () => {
    const shouts = parseShoutsResponse({
      mentions: [
        row({ id: ID('a'), createdAt: 300 }),
        row({ id: ID('b'), createdAt: 200 }),
        row({ id: ID('d'), createdAt: 100 }),
      ],
    }).shouts;

    expect(countNew(shouts, 0)).toBe(3);
    expect(countNew(shouts, 200)).toBe(1);
    expect(countNew(shouts, 300)).toBe(0);
  });
});

describe('unseenShoutCount', () => {
  it('counts only what landed since this device last looked', async () => {
    await markShoutsSeen(200);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          mentions: [row({ id: ID('a'), createdAt: 300 }), row({ id: ID('b'), createdAt: 100 })],
        }),
      }) as Response) as unknown as typeof globalThis.fetch);

    expect(await unseenShoutCount(ME)).toBe(1);
  });

  it('asks for one small page — the badge is a dot, not a total', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ mentions: [] }) } as Response;
    }) as unknown as typeof globalThis.fetch);

    expect(await unseenShoutCount(ME)).toBe(0);
    expect(seen[0]).toContain('limit=10');
  });
});
