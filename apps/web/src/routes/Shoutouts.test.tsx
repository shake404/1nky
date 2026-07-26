import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shout-outs.
 *
 * The screen has one job that is easy to get wrong: telling a writer which of
 * these they have not seen. "New" is worked out against a stamp the device
 * keeps, and the stamp has to be snapshotted on arrival — write it first and
 * every row goes grey the instant you walk in, which is exactly the moment the
 * marks are useful.
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

const { Shoutouts } = await import('./Shoutouts.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle, getPref } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { markShoutsSeen, resetShoutsSeenCache } = await import('../lib/shoutouts.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const ID = (char: string): string => char.repeat(64);
const NOW = Math.floor(Date.now() / 1000);

function shout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID('a'),
    createdAt: NOW - 600,
    content: 'ask @KILO, he was there',
    writer: { pubkey: ID('b'), tag: 'SMOG' },
    where: { id: ID('1'), type: 'flick', subject: null, excerpt: 'rooftop' },
    ...overrides,
  };
}

let asked: string[] = [];

function wallFetch(rows: unknown[], cursor: string | null = null): typeof globalThis.fetch {
  return vi.fn(async (input: unknown) => {
    asked.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ mentions: rows, nextCursor: cursor }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  resetShoutsSeenCache();
  asked = [];
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

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <MemoryRouter initialEntries={['/mentions']}>
          <Shoutouts />
        </MemoryRouter>
      </TagProvider>,
    );
  });
  await settle();
}

describe('the shout-outs screen', () => {
  it('shows who said your name, what they said, and where', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout()]));

    await mount();

    const link = container.querySelector(`a[href="/f/${ID('1')}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('ask @KILO, he was there');
    expect(link!.textContent).toContain('SMOG');
    expect(link!.textContent).toContain('rooftop');
  });

  it('sends a thread shout to the thread it happened in', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      wallFetch([
        shout({ where: { id: ID('2'), type: 'thread', subject: 'Alameda wall', excerpt: 'x' } }),
      ]),
    );

    await mount();

    const link = container.querySelector(`a[href="/t/${ID('2')}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('Alameda wall');
  });

  it('asks the wall for this writer only', async () => {
    const tag = await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([]));

    await mount();

    expect(asked[0]).toContain(`/mentions/${tag.pubkey}`);
  });

  it('marks what landed since the last look, and leaves the rest plain', async () => {
    await createTag('WRITER');
    await markShoutsSeen(NOW - 3600);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      wallFetch([
        shout({ id: ID('a'), createdAt: NOW - 60 }),
        shout({ id: ID('d'), createdAt: NOW - 7200 }),
      ]),
    );

    await mount();

    const rows = [...container.querySelectorAll('a.shout')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains('shout--new')).toBe(true);
    expect(rows[1]?.classList.contains('shout--new')).toBe(false);
  });

  it('does not grey out the marks the moment you walk in', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout({ createdAt: NOW - 60 })]));

    await mount();

    // The stamp has moved (so the top bar dot clears)...
    expect(await getPref<number>('shouts-seen', 0)).toBeGreaterThan(0);
    // ...but the row you came to look at is still marked, this visit.
    expect(container.querySelector('a.shout')?.classList.contains('shout--new')).toBe(true);
  });

  it('does not claim to have looked when the read never landed', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    await mount();

    expect(await getPref<number>('shouts-seen', 0)).toBe(0);
    expect(container.textContent).toContain('Could not reach the wall.');
  });

  it('says so plainly when nobody has said your name', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([]));

    await mount();

    expect(container.textContent).toContain('Nobody has said your name yet.');
    expect(container.querySelector('a[href="/boards"]')).not.toBeNull();
  });

  it('pages when there is more', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout()], 'next-page'));

    await mount();

    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === 'More');
    expect(more).toBeDefined();
    await act(async () => {
      (more as HTMLButtonElement).click();
    });
    await settle();
    expect(asked.at(-1)).toContain('cursor=next-page');
  });

  it('speaks the register, not the protocol', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout()]));

    await mount();

    const text = (container.textContent ?? '').toLowerCase();
    for (const word of JARGON_BLOCKLIST) expect(text).not.toContain(word);
    for (const word of ['p-tag', 'event', 'kind ', 'tagged you']) expect(text).not.toContain(word);
  });
});
