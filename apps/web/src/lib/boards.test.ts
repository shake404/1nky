import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Boards, threads and the beef countdown.
 *
 * The countdown is the piece with real logic in it — a writer decides whether
 * to bother replying based on what this says, so "under six hours" and "already
 * gone" both have to be right, and a thread with no clock must get no chip at
 * all rather than a zero.
 */

// Nothing in this module talks to the wall directly, but mute.ts pulls publish.ts
// in, which reaches the relay singleton on import.
vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(async () => ({ id: 'x'.repeat(64) })),
}));

const boards = await import('./boards.js');
const { resetDbHandle, setPref } = await import('./db.js');
const mute = await import('./mute.js');
const { API_BASE } = await import('./config.js');

const HOUR = 3600;
const DAY = 86_400;
const NOW = 1_800_000_000;

const alpha = 'a'.repeat(64);
const beta = 'b'.repeat(64);
const gamma = 'c'.repeat(64);

function writer(pubkey: string, tag: string): Record<string, unknown> {
  return { pubkey, tag, mark: 'aa11bb', avatarSha256: null };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  mute.resetIgnoredCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('beefClock', () => {
  it('has nothing to say about a thread that stays up', () => {
    expect(boards.beefClock(null, NOW)).toBeNull();
    expect(boards.beefClock(undefined, NOW)).toBeNull();
    expect(boards.beefClock(0, NOW)).toBeNull();
  });

  it('counts down in days, then hours, then minutes', () => {
    expect(boards.beefClock(NOW + 3 * DAY, NOW)?.text).toBe('dies in 3d');
    expect(boards.beefClock(NOW + 23 * HOUR, NOW)?.text).toBe('dies in 23h');
    expect(boards.beefClock(NOW + 40 * 60, NOW)?.text).toBe('dies in 40m');
  });

  it('never shows a zero — the last stretch still reads as a whole minute', () => {
    expect(boards.beefClock(NOW + 20, NOW)?.text).toBe('dies in 1m');
  });

  it('goes urgent inside the last six hours and not before', () => {
    expect(boards.beefClock(NOW + 7 * HOUR, NOW)?.urgent).toBe(false);
    expect(boards.beefClock(NOW + 6 * HOUR, NOW)?.urgent).toBe(false);
    expect(boards.beefClock(NOW + 6 * HOUR - 1, NOW)?.urgent).toBe(true);
    expect(boards.beefClock(NOW + 30 * 60, NOW)?.urgent).toBe(true);
  });

  it('reads as buffed by time once it is past', () => {
    const clock = boards.beefClock(NOW - 1, NOW);
    expect(clock).toEqual({ text: 'buffed by time', urgent: false, gone: true });
  });

  it('says nothing about how long anything runs in wire terms', () => {
    const words = [
      boards.beefClock(NOW + DAY, NOW)?.text ?? '',
      boards.beefClock(NOW - 5, NOW)?.text ?? '',
    ]
      .join(' ')
      .toLowerCase();
    for (const banned of ['expiration', 'expires', 'nip', 'event', 'kind', 'relay']) {
      expect(words).not.toContain(banned);
    }
  });
});

describe('threadHeadline', () => {
  it('prefers the title', () => {
    expect(boards.threadHeadline({ subject: 'Toy season', excerpt: 'body text' })).toBe('Toy season');
  });

  it('falls back to the first line of the writing', () => {
    expect(boards.threadHeadline({ subject: null, excerpt: 'first line\nsecond line' })).toBe('first line');
  });

  it('has something to show for a thread with neither', () => {
    expect(boards.threadHeadline({ subject: null, excerpt: '   ' })).toBe('no words');
  });
});

describe('parseBoardsResponse', () => {
  it('reads the board list and defaults a missing title to the slug', () => {
    const list = boards.parseBoardsResponse({
      boards: [
        { slug: 'sf-bay', title: 'SF Bay', kind: 'city', createdAt: 10, flickCount: 4, threadCount: 2, latestAt: 99 },
        { slug: 'oakland', kind: 'city', flickCount: 0, threadCount: 0, latestAt: null },
        { nonsense: true },
      ],
    });

    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      slug: 'sf-bay',
      title: 'SF Bay',
      kind: 'city',
      createdAt: 10,
      flickCount: 4,
      threadCount: 2,
      latestAt: 99,
    });
    expect(list[1]?.title).toBe('oakland');
    expect(list[1]?.latestAt).toBeNull();
  });
});

describe('parseBoardResponse', () => {
  const payload = {
    board: { slug: 'sf-bay', title: 'SF Bay', kind: 'city', regionSlug: 'bay-area' },
    threads: [
      {
        id: '1'.repeat(64),
        subject: 'Who buffed the yard',
        excerpt: 'somebody rolled the whole thing',
        writer: writer(alpha, 'SHOCK'),
        createdAt: NOW - HOUR,
        expiresAt: NOW + DAY,
        replyCount: 3,
        lastReplyAt: NOW - 60,
      },
      {
        id: '2'.repeat(64),
        subject: null,
        excerpt: 'no title on this one',
        writer: writer(beta, 'RASK'),
        createdAt: NOW - 2 * HOUR,
        expiresAt: null,
        replyCount: 0,
        lastReplyAt: null,
      },
      { id: 'not-hex', writer: writer(gamma, 'JUNK') },
    ],
    nextCursor: 'abc',
  };

  it('reads the board, its threads and the cursor', () => {
    const page = boards.parseBoardResponse(payload);
    expect(page.board).toEqual({ slug: 'sf-bay', title: 'SF Bay', kind: 'city', regionSlug: 'bay-area' });
    expect(page.threads.map((t) => t.id)).toEqual(['1'.repeat(64), '2'.repeat(64)]);
    expect(page.threads[0]?.expiresAt).toBe(NOW + DAY);
    expect(page.threads[1]?.expiresAt).toBeNull();
    expect(page.cursor).toBe('abc');
  });

  it('drops threads from a writer you are ignoring', async () => {
    await setPref('ignored-writers', [alpha]);
    await mute.loadIgnored();

    const page = boards.parseBoardResponse(payload);
    expect(page.threads.map((t) => t.id)).toEqual(['2'.repeat(64)]);
  });
});

describe('parseThreadResponse', () => {
  const payload = {
    thread: {
      id: '1'.repeat(64),
      subject: 'Beef',
      content: 'say it to my face',
      boards: ['sf-bay'],
      writer: writer(alpha, 'SHOCK'),
      createdAt: NOW - HOUR,
      expiresAt: NOW + 2 * HOUR,
      replyCount: 2,
    },
    comments: [
      {
        id: 'a'.repeat(64),
        parentId: '1'.repeat(64),
        createdAt: NOW - 30 * 60,
        content: 'said',
        writer: writer(beta, 'RASK'),
        replies: [
          {
            id: 'b'.repeat(64),
            parentId: 'a'.repeat(64),
            createdAt: NOW - 20 * 60,
            content: 'and again',
            writer: writer(gamma, 'FADE'),
            replies: [],
          },
        ],
      },
    ],
  };

  it('reads the opening post and the nested replies', () => {
    const view = boards.parseThreadResponse(payload);
    expect(view?.thread.subject).toBe('Beef');
    expect(view?.thread.boards).toEqual(['sf-bay']);
    expect(view?.comments).toHaveLength(1);
    expect(view?.comments[0]?.replies[0]?.content).toBe('and again');
  });

  it('takes an ignored writer out along with everything under them', async () => {
    await setPref('ignored-writers', [beta]);
    await mute.loadIgnored();

    const view = boards.parseThreadResponse(payload);
    expect(view?.comments).toHaveLength(0);
  });

  it('is null when there is no thread in the answer', () => {
    expect(boards.parseThreadResponse({})).toBeNull();
    expect(boards.parseThreadResponse({ thread: { id: 'nope' } })).toBeNull();
  });
});

describe('requests', () => {
  it('asks for one kind of board when told to', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ boards: [] }) } as unknown as Response);

    await boards.fetchBoards('city');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API_BASE}/boards?kind=city`);

    await boards.fetchBoards();
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${API_BASE}/boards`);
  });

  it('passes the cursor through on a board page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ board: null, threads: [] }),
    } as unknown as Response);

    await boards.fetchBoard('sf-bay', 'CUR');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname.endsWith('/board/sf-bay')).toBe(true);
    expect(url.searchParams.get('cursor')).toBe('CUR');
  });

  it('gives up rather than inventing a thread when the wall is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    await expect(boards.fetchThread('1'.repeat(64))).rejects.toThrow();
  });

  it('is patient with a thread the wall has not filed yet', async () => {
    const body = {
      thread: {
        id: '1'.repeat(64),
        subject: 'Beef',
        content: 'say it',
        boards: ['sf-bay'],
        writer: { pubkey: 'a'.repeat(64), tag: 'SHOCK', mark: 'aaaaaa', avatarSha256: null },
        createdAt: 1_800_000_000,
        expiresAt: null,
        replyCount: 0,
      },
      comments: [],
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response)
      .mockResolvedValue({ ok: true, status: 200, json: async () => body } as unknown as Response);

    const view = await boards.fetchThreadPatient('1'.repeat(64), { waitMs: 0 });
    expect(view?.thread.subject).toBe('Beef');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps asking until the reply count catches up, then settles', async () => {
    const at = (replyCount: number): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          thread: {
            id: '1'.repeat(64),
            subject: null,
            content: 'say it',
            boards: [],
            writer: { pubkey: 'a'.repeat(64), tag: null, mark: 'aaaaaa', avatarSha256: null },
            createdAt: 1_800_000_000,
            expiresAt: null,
            replyCount,
          },
          comments: [],
        }),
      }) as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(at(0)).mockResolvedValue(at(1));

    const view = await boards.fetchThreadPatient('1'.repeat(64), { waitMs: 0, expectReplies: 1 });
    expect(view?.thread.replyCount).toBe(1);
  });

  it('patience runs out to the stale answer, not a lie', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    await expect(boards.fetchThreadPatient('1'.repeat(64), { waitMs: 0, tries: 2 })).rejects.toThrow();
  });
});
