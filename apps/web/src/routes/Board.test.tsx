import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One board.
 *
 * The countdown chip is the thing worth pinning: a thread with hours left has
 * to read as urgent, a thread that stays up gets no chip at all, and one whose
 * time already ran out must not still be sitting in the list as if it were
 * live.
 */

vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Board } = await import('./Board.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
/**
 * The countdown floors, so a lifetime of exactly 23h renders as "22h" the
 * moment the clock ticks past the fixture. Every expiry below sits a few
 * minutes clear of its hour boundary.
 */
const CLEAR = 300;

const LIVE = '1'.repeat(64);
const HOT = '2'.repeat(64);
const PINNED = '3'.repeat(64);
const DEAD = '4'.repeat(64);

function writer(pubkey: string, tag: string): Record<string, unknown> {
  return { pubkey, tag, mark: 'aa11bb', avatarSha256: null };
}

const BOARD = {
  board: { slug: 'sf-bay', title: 'sf-bay', kind: 'city', regionSlug: 'bay-area' },
  threads: [
    {
      id: LIVE,
      subject: 'Who buffed the yard',
      excerpt: 'somebody rolled the whole thing overnight',
      writer: writer('a'.repeat(64), 'SHOCK'),
      createdAt: NOW - 2 * HOUR,
      expiresAt: NOW + 23 * HOUR + CLEAR,
      replyCount: 4,
      lastReplyAt: NOW - 600,
    },
    {
      id: HOT,
      subject: null,
      excerpt: 'last call on this one\nsecond line nobody reads',
      writer: writer('b'.repeat(64), 'RASK'),
      createdAt: NOW - 20 * HOUR,
      expiresAt: NOW + 2 * HOUR + CLEAR,
      replyCount: 1,
      lastReplyAt: NOW - 90,
    },
    {
      id: PINNED,
      subject: 'Board rules',
      excerpt: 'read them',
      writer: writer('c'.repeat(64), 'FADE'),
      createdAt: NOW - 90 * HOUR,
      expiresAt: null,
      replyCount: 0,
      lastReplyAt: null,
    },
    {
      id: DEAD,
      subject: 'Already over',
      excerpt: 'ran out',
      writer: writer('d'.repeat(64), 'GONE'),
      createdAt: NOW - 100 * HOUR,
      expiresAt: NOW - HOUR,
      replyCount: 9,
      lastReplyAt: NOW - 2 * HOUR,
    },
  ],
  nextCursor: null,
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function boardFetch(body: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response) as unknown as typeof globalThis.fetch;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  setActEnv(false);
});

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <MemoryRouter initialEntries={['/b/sf-bay']}>
          <Routes>
            <Route path="/b/:slug" element={<Board />} />
          </Routes>
        </MemoryRouter>
      </TagProvider>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function row(id: string): HTMLElement | null {
  return container.querySelector(`a[href="/t/${id}"]`);
}

describe('a board page', () => {
  it('names the board and lists the threads on it', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    expect(container.querySelector('h2')?.textContent).toBe('sf-bay');
    expect(row(LIVE)?.textContent).toContain('Who buffed the yard');
    // No title: the first line stands in for one, and only the first line.
    expect(row(HOT)?.textContent).toContain('last call on this one');
    expect(row(HOT)?.textContent).not.toContain('second line nobody reads');
    // Reply counts read as words, singular when there is one.
    expect(row(LIVE)?.textContent).toContain('4 replies');
    expect(row(HOT)?.textContent).toContain('1 reply');
    expect(row(PINNED)?.textContent).toContain('no replies');
  });

  it('counts only the threads that are still alive', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    // Four came back, one had already run out.
    expect(container.textContent).toContain('3 threads');
    expect(row(DEAD)).toBeNull();
  });

  it('puts a countdown on a beef thread and goes hot inside the last six hours', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    const live = row(LIVE)!.querySelector('.beef-clock');
    expect(live?.textContent).toBe('dies in 23h');
    expect(live?.classList.contains('beef-clock--hot')).toBe(false);

    const hot = row(HOT)!.querySelector('.beef-clock');
    expect(hot?.textContent).toBe('dies in 2h');
    expect(hot?.classList.contains('beef-clock--hot')).toBe(true);
  });

  it('leaves a thread that stays up without a countdown', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    expect(row(PINNED)!.querySelector('.beef-clock')).toBeNull();
  });

  it('offers the way to start one, pointed at this board', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    const start = container.querySelector('a[href="/b/sf-bay/new"]');
    expect(start).not.toBeNull();
    expect(start!.textContent).toContain('Start one');
  });

  it('invites the first word when nobody is talking', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch({ board: BOARD.board, threads: [] }));

    await mount();

    expect(container.textContent).toContain("Nobody's talking here.");
  });

  it('switches to the board’s own wall of flicks on request', async () => {
    await createTag('WRITER');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
      const url = String(input);
      const body = url.includes('/feed')
        ? {
            items: [
              {
                id: 'e'.repeat(64),
                url: 'https://media.example/one.webp',
                sha256: 'f'.repeat(64),
                writer: { pubkey: 'a'.repeat(64), tag: 'SHOCK' },
                createdAt: NOW - 100,
                width: 800,
                height: 1000,
                caption: 'on the board',
              },
            ],
          }
        : BOARD;
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });

    await mount();

    const flicksTab = [...container.querySelectorAll('button')].find((b) => b.textContent === 'flicks');
    await act(async () => {
      flicksTab!.click();
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // The wall was asked for this board only.
    const feedCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/feed'));
    expect(feedCall).toBeDefined();
    expect(new URL(feedCall!).searchParams.get('board')).toBe('sf-bay');
    expect(container.querySelector('.wall')).not.toBeNull();
    expect(container.textContent).toContain('on the board');
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch(BOARD));

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
