import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The search screen.
 *
 * What is worth pinning: the wall is asked ONCE for a burst of typing (not once
 * per keystroke), all three kinds of answer land in the right place, and both
 * quiet states — nothing typed yet, nothing found — say something in the
 * interface's own voice rather than showing an empty page.
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

const { Search } = await import('./Search.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { SEARCH_DEBOUNCE_MS } = await import('../lib/search.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const NOW = Math.floor(Date.now() / 1000);

const FLICK = '1'.repeat(64);
const CLIP = '2'.repeat(64);
const THREAD = '3'.repeat(64);
const SHOCK = 'a'.repeat(64);

const ANSWER = {
  q: 'sf',
  boards: ['sf-bay', 'oakland'],
  writers: [{ pubkey: SHOCK, tag: 'SHOCK', mark: 'aa11bb', avatarSha256: null, city: 'sf' }],
  flicks: [
    {
      id: FLICK,
      url: 'https://media.example/one.webp',
      sha256: 'f'.repeat(64),
      writer: { pubkey: SHOCK, tag: 'SHOCK' },
      createdAt: NOW - 600,
      width: 900,
      height: 1200,
      caption: 'rooftop in the fog',
    },
  ],
  videos: [
    {
      id: CLIP,
      url: 'https://media.example/one.mp4',
      sha256: 'e'.repeat(64),
      writer: { pubkey: SHOCK, tag: 'SHOCK' },
      createdAt: NOW - 60,
      width: 1280,
      height: 720,
      caption: 'rolling a panel',
      posterUrl: 'https://media.example/poster.webp',
      duration: 12,
    },
  ],
  threads: [
    {
      id: THREAD,
      subject: 'Who buffed the yard',
      excerpt: 'somebody rolled the whole thing',
      writer: { pubkey: SHOCK, tag: 'SHOCK', mark: 'aa11bb', avatarSha256: null },
      createdAt: NOW - 3600,
      expiresAt: null,
      replyCount: 4,
    },
  ],
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function answering(body: unknown, ok = true): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response) as unknown as typeof globalThis.fetch,
  );
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

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(entry = '/search'): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/search" element={<Search />} />
          </Routes>
        </MemoryRouter>
      </TagProvider>,
    );
  });
  await settle();
}

function box(): HTMLInputElement {
  return container.querySelector('input#search-q') as HTMLInputElement;
}

/** One keystroke's worth of typing, without waiting for the ask to go out. */
async function type(value: string): Promise<void> {
  const node = box();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Let the debounce run out, then let the answer land. */
async function waitForAsk(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 60));
  });
  await settle();
}

describe('the search screen', () => {
  it('opens with an empty box and asks the writer what they are after', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();

    expect(box()).not.toBeNull();
    expect(container.textContent).toContain('Looking for something?');
    // Nothing typed, nothing asked.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('puts the writers first — somebody typing a tag is after the writer', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();
    await type('shock');
    await waitForAsk();

    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings[0]).toBe('Writers');
    expect(headings).toEqual(['Writers', 'Walls', 'Up', 'Talk']);

    // The row is a door to their wall, and it carries their mark.
    const row = container.querySelector(`a[href="/w/${SHOCK}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('SHOCK');
    expect(row!.textContent).toContain('aa11bb');
  });

  it('finds a writer even when nothing else matched — the bug this fixes', async () => {
    await createTag('WRITER');
    answering({ q: 'shake', boards: [], writers: ANSWER.writers, flicks: [], videos: [], threads: [] });

    await mount();
    await type('shake');
    await waitForAsk();

    expect(container.textContent).not.toContain('Nothing on the wall for that.');
    expect(container.querySelector(`a[href="/w/${SHOCK}"]`)).not.toBeNull();
  });

  it('lays the answer out as walls, then what is up, then talk', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();
    await type('sf');
    await waitForAsk();

    // Walls are tappable straight through to the board.
    expect(container.querySelector('a[href="/b/sf-bay"]')).not.toBeNull();
    expect(container.querySelector('a[href="/b/oakland"]')).not.toBeNull();
    // A flick and a clip share one wall.
    expect(container.querySelector('.wall')).not.toBeNull();
    expect(container.querySelector(`a[href="/f/${FLICK}"]`)).not.toBeNull();
    expect(container.querySelector(`a[href="/f/${CLIP}"]`)).not.toBeNull();
    expect(container.querySelector('.wall video')).not.toBeNull();
    // Talk uses the same row a board uses.
    const row = container.querySelector(`a[href="/t/${THREAD}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Who buffed the yard');
    expect(row!.textContent).toContain('4 replies');
  });

  it('asks the wall once for a burst of typing, and asks for the last thing typed', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();
    await type('s');
    await type('sf');
    await type('sf b');
    await waitForAsk();

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    expect(new URL(String(calls[0]?.[0])).searchParams.get('q')).toBe('sf b');
  });

  it('says so plainly when the wall has nothing', async () => {
    await createTag('WRITER');
    answering({ q: 'zzzz', boards: [], flicks: [], videos: [], threads: [] });

    await mount();
    await type('zzzz');
    await waitForAsk();

    expect(container.textContent).toContain('Nothing on the wall for that.');
  });

  it('renders the walls and flicks an older box sends, with no talk in the answer', async () => {
    await createTag('WRITER');
    answering({ q: 'sf', boards: ['sf-bay'], flicks: ANSWER.flicks });

    await mount();
    await type('sf');
    await waitForAsk();

    expect(container.querySelector('a[href="/b/sf-bay"]')).not.toBeNull();
    expect(container.querySelector(`a[href="/f/${FLICK}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain('Nothing on the wall for that.');
  });

  it('admits it when the wall cannot be reached', async () => {
    await createTag('WRITER');
    answering(null, false);

    await mount();
    await type('sf');
    await waitForAsk();

    expect(container.textContent).toContain('Could not reach the wall.');
  });

  it('runs the search that arrived in the link', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount('/search?q=sf%20bay');
    await settle();

    expect(box().value).toBe('sf bay');
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(new URL(String(calls[0]?.[0])).searchParams.get('q')).toBe('sf bay');
  });

  it('goes quiet again when the box is emptied', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();
    await type('sf');
    await waitForAsk();
    await type('');
    await settle();

    expect(container.textContent).toContain('Looking for something?');
    expect(container.querySelector('.wall')).toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('WRITER');
    answering(ANSWER);

    await mount();
    await type('sf');
    await waitForAsk();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
