import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hollering.
 *
 * The whole promise of this screen is that complaining costs nothing extra: it
 * is an ordinary post on an ordinary board, read through the same wall read as
 * any other board. So the tests pin the two things that make it that — the read
 * goes at `/board/holler`, and what goes up carries no lifetime, because
 * feedback that evaporates overnight is feedback nobody acted on.
 */

/** Every template that reached the miner, in order. */
const mined: { kind: number; tags: string[][]; content: string; created_at: number }[] = [];

vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

vi.mock('../lib/pow.js', () => ({
  mineAndSign: vi.fn(
    async (
      template: { kind: number; tags: string[][]; content: string; created_at: number },
      _secret: Uint8Array,
      pubkey: string,
    ) => {
      mined.push(template);
      return { ...template, id: 'f'.repeat(64), pubkey, sig: '0'.repeat(128) };
    },
  ),
  stopMiner: vi.fn(),
}));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Holler } = await import('./Holler.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

const NOW = Math.floor(Date.now() / 1000);
const HOLLERED = '1'.repeat(64);

const BOARD = {
  board: { slug: 'holler', title: 'holler', kind: 'feedback', regionSlug: null },
  threads: [
    {
      id: HOLLERED,
      subject: 'The wall eats long captions',
      excerpt: 'anything past two lines gets cut',
      writer: { pubkey: 'a'.repeat(64), tag: 'SHOCK', mark: 'aa11bb', avatarSha256: null },
      createdAt: NOW - 4000,
      expiresAt: null,
      replyCount: 2,
      lastReplyAt: NOW - 300,
    },
  ],
  nextCursor: null,
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  mined.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  await createTag('SHOCK');
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

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function boardFetch(body: unknown = BOARD): typeof globalThis.fetch {
  return vi.fn(
    async () => ({ ok: true, status: 200, json: async () => body }) as Response,
  ) as unknown as typeof globalThis.fetch;
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/holler']}>
            <Routes>
              <Route path="/holler" element={<Holler />} />
              <Route path="/t/:id" element={<p>landed on the thread</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function type(id: string, value: string): Promise<void> {
  const node = container.querySelector(`#${id}`) as HTMLTextAreaElement | HTMLInputElement | null;
  if (!node) throw new Error(`no field #${id}`);
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function picked(): string | undefined {
  return (
    container.querySelector('.beef-pick__option--on')?.querySelector('.beef-pick__label')
      ?.textContent ?? undefined
  );
}

function holler(): void {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Holler');
  if (!found) throw new Error('no holler button');
  found.click();
}

describe('the holler board', () => {
  it('says up front that it costs nothing more than a post', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    expect(container.querySelector('h2')?.textContent).toBe('Holler at us');
    expect(container.textContent).toContain(
      'Same rules as the wall: no name, no number, just your tag.',
    );
    expect(container.textContent).toContain(
      "Say what's broken, what's missing, what should burn.",
    );
    expect(container.textContent).toContain('rides the same rails as everything else');
  });

  it('reads the one board it is pinned to and lists what is on it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/board/holler'))).toBe(true);

    const row = container.querySelector(`a[href="/t/${HOLLERED}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('The wall eats long captions');
    expect(row!.textContent).toContain('2 replies');
  });

  it('invites the first word when nobody has hollered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch({ board: BOARD.board, threads: [] }));

    await mount();

    expect(container.textContent).toContain("Nobody's hollered yet.");
  });

  it('starts the compose on pinned, with all four lifetimes still there', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    expect(picked()).toBe('pinned');
    expect(container.querySelectorAll('.beef-pick__option')).toHaveLength(4);
    for (const label of ['24 hours', '3 days', 'a week', 'pinned']) {
      expect(container.textContent).toContain(label);
    }
  });

  it('puts a holler up on the holler board with no lifetime on it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    await type('thread-body', 'the wall eats long captions');
    await act(async () => {
      holler();
    });
    await settle();

    expect(mined).toHaveLength(1);
    const template = mined[0]!;
    expect(template.kind).toBe(KINDS.NOTE);
    expect(template.tags.filter((t) => t[0] === 't')).toEqual([['t', 'holler']]);
    // Pinned by default: nothing takes it away.
    expect(template.tags.filter((t) => t[0] === 'expiration')).toEqual([]);
    expect(container.textContent).toContain('landed on the thread');
  });

  it('still lets somebody put a lifetime on their own holler', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    await type('thread-body', 'gone tomorrow, this one');
    const day = [...container.querySelectorAll('.beef-pick__option')].find(
      (b) => b.querySelector('.beef-pick__label')?.textContent === '24 hours',
    );
    await act(async () => {
      (day as HTMLButtonElement).click();
    });
    await act(async () => {
      holler();
    });
    await settle();

    expect(mined[0]!.tags.filter((t) => t[0] === 'expiration')).toHaveLength(1);
  });

  it('points at the list of what is coming', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    expect(container.querySelector('a[href="/roadmap"]')).not.toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardFetch());

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
