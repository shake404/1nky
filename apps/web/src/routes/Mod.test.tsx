import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mod console.
 *
 * Two things are load-bearing and neither is visible from the markup alone:
 * the key gate (nothing renders without a working key, and a bad one puts the
 * gate back), and the ordering of the one-tap action — the post has to come
 * down BEFORE the writer is stopped, so a half-failure never leaves the post
 * up while looking finished.
 */

// Identicon paints a canvas; happy-dom has no 2D context.
vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

// Nothing may open a socket or grind real work in a route test.
vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as typeof import('../lib/relay.js')['relay'],
}));

/** Every template that went up, in order. */
const published: { kind: number; tags: string[][]; content: string }[] = [];

vi.mock('../lib/publish.js', () => ({
  publishTemplate: vi.fn(
    async (
      _secret: Uint8Array,
      _pubkey: string,
      template: { kind: number; tags: string[][]; content: string },
    ) => {
      published.push(template);
      return { id: 'p'.repeat(64) };
    },
  ),
  buffEvents: vi.fn(
    async (_tag: unknown, ids: readonly string[], kinds: readonly number[]) => {
      published.push({
        kind: 5,
        tags: [...ids.map((id) => ['e', id]), ...kinds.map((k) => ['k', String(k)])],
        content: '',
      });
      return { id: 'b'.repeat(64) };
    },
  ),
}));

const { Mod } = await import('./Mod.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { saveModKey } = await import('../lib/mod.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

const TARGET = 'a'.repeat(64);
const REPORTER = 'c'.repeat(64);
const POST = 'd'.repeat(64);

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

const QUEUE = {
  reports: [
    {
      id: 'e'.repeat(64),
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      reason: 'illegal',
      note: 'this one is over the line',
      reporter: {
        pubkey: REPORTER,
        mark: 'aa11bb',
        firstEventAt: Math.floor(Date.now() / 1000) - 3 * 86400,
        eventCount: 12,
        reportCount: 1,
      },
      target: {
        pubkey: TARGET,
        tag: 'SHOCK',
        mark: 'cc22dd',
        eventId: POST,
        kind: KINDS.FLICK,
        content: 'a caption on the flagged flick',
        createdAt: Math.floor(Date.now() / 1000) - 7200,
        thumbnailUrl: 'https://media.example/thumb.webp',
        blurhash: null,
        boards: ['type-throwie'],
        reportCount: 4,
        banned: false,
        present: true,
      },
    },
  ],
};

/** A `fetch` stand-in that answers /mod/* by status code. */
function modFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  published.length = 0;
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
        <ToastProvider>
          <MemoryRouter initialEntries={['/mod']}>
            <Mod />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button matching "${text}" — saw: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return found as HTMLButtonElement;
}

describe('the key gate', () => {
  it('shows the key field and no queue until a key is stored', async () => {
    await createTag('MOD');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();

    expect(container.querySelector('#mod-key')).not.toBeNull();
    expect(container.textContent).not.toContain('SHOCK');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('puts the gate back with a plain message when the key is refused', async () => {
    await createTag('MOD');
    await saveModKey('wrong-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(401, { error: 'unauthorized' }));

    await mount();

    expect(container.textContent).toContain("That key doesn't work.");
    expect(container.querySelector('#mod-key')).not.toBeNull();
  });

  it('says the tools are off when the server has no key configured', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(503, {}));

    await mount();

    expect(container.textContent).toContain('Mod tools are switched off on the server.');
  });

  it('forgets the key on request and drops back to the gate', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();
    expect(container.textContent).toContain('SHOCK');

    await act(async () => {
      button('Forget this key').click();
    });
    await settle();

    expect(container.querySelector('#mod-key')).not.toBeNull();
  });
});

describe('the queue', () => {
  it('renders a flagged post with the reason, both marks and the reporter age', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();

    expect(container.textContent).toContain('SHOCK');
    expect(container.textContent).toContain('cc22dd');
    // Wire reason never leaks; its label does.
    expect(container.textContent).toContain('Straight-up illegal');
    expect(container.textContent).not.toContain('illegal"');
    // Reporter provenance.
    expect(container.textContent).toContain('aa11bb');
    expect(container.textContent).toMatch(/3d on the wall/);
    // The flagged media and a way through to the post.
    expect(container.querySelector('img.mod-card__thumb')?.getAttribute('src')).toBe(
      'https://media.example/thumb.webp',
    );
    expect(container.querySelector(`a[href="/f/${POST}"]`)).not.toBeNull();
  });

  it('says nothing from the jargon blocklist, even on the staff screen', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });

  it('"Buff + ban" takes the post down first, then bans the writer', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();

    await act(async () => {
      button('Buff + ban').click();
    });
    await settle();

    expect(published).toHaveLength(2);
    // 1. the takedown — a kind 5 naming the flagged post.
    expect(published[0]?.kind).toBe(KINDS.DELETE);
    expect(published[0]?.tags).toContainEqual(['e', POST]);
    // 2. the ban — a kind 30078 keyed to the writer, carrying the reason.
    expect(published[1]?.kind).toBe(KINDS.APP_DATA);
    expect(published[1]?.tags).toContainEqual(['d', `ban:${TARGET}`]);
    expect(published[1]?.tags).toContainEqual(['p', TARGET]);
    expect(JSON.parse(published[1]?.content ?? '{}')).toEqual({ action: 'ban', reason: 'illegal' });

    // The card is hidden once it is handled.
    expect(container.textContent).not.toContain('SHOCK');
  });

  it('"Leave it" hides the card without putting anything up', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation(modFetch(200, QUEUE));

    await mount();

    await act(async () => {
      button('Leave it').click();
    });
    await settle();

    expect(published).toHaveLength(0);
    expect(container.textContent).not.toContain('SHOCK');
    expect(container.textContent).toContain('Queue is clear.');
  });
});

describe('the banlist', () => {
  it('lists banned writers and unbans one', async () => {
    await createTag('MOD');
    await saveModKey('right-one');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
      const url = String(input);
      const body = url.includes('/mod/banlist')
        ? {
            banned: [
              {
                pubkey: TARGET,
                mark: 'cc22dd',
                reason: 'spam',
                bannedAt: Math.floor(Date.now() / 1000) - 86400,
                bannedBy: REPORTER,
                reportCount: 9,
                eventCount: 40,
              },
            ],
          }
        : QUEUE;
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });

    await mount();

    await act(async () => {
      button('Banned').click();
    });
    await settle();

    expect(container.textContent).toContain('cc22dd');
    expect(container.textContent).toContain('Spam');

    await act(async () => {
      button('Unban').click();
    });
    await settle();

    expect(published).toHaveLength(1);
    expect(published[0]?.kind).toBe(KINDS.APP_DATA);
    expect(JSON.parse(published[0]?.content ?? '{}')).toEqual({ action: 'unban' });
  });
});
