import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The top bar's shout-out light.
 *
 * The dock is full at eight tabs and the desktop row is full at its labels, so
 * shout-outs live in the top bar as a glyph — which makes this dot the only
 * thing on any screen that can tell a writer somebody said their name. It has
 * to light up when there is something unseen, stay dark when there is not, and
 * go out the moment the screen writes its last-looked stamp.
 */

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { TopBar } = await import('./Shell.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { markShoutsSeen, resetShoutsSeenCache } = await import('../lib/shoutouts.js');

const ID = (char: string): string => char.repeat(64);
const NOW = Math.floor(Date.now() / 1000);

function shout(createdAt: number): Record<string, unknown> {
  return {
    id: ID('a'),
    createdAt,
    content: 'saw @you up there',
    writer: { pubkey: ID('b'), tag: 'SMOG' },
    where: { id: ID('1'), type: 'flick', subject: null, excerpt: 'rooftop' },
  };
}

function wallFetch(rows: unknown[]): typeof globalThis.fetch {
  return vi.fn(
    async () => ({ ok: true, status: 200, json: async () => ({ mentions: rows }) }) as Response,
  ) as unknown as typeof globalThis.fetch;
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
        <MemoryRouter initialEntries={['/']}>
          <TopBar />
        </MemoryRouter>
      </TagProvider>,
    );
  });
  await settle();
}

function glyph(): Element | null {
  return container.querySelector('a[href="/mentions"]');
}

describe('the shout-out light', () => {
  it('lights up when somebody has said your name since you last looked', async () => {
    await createTag('WRITER');
    await markShoutsSeen(NOW - 3600);
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout(NOW - 60)]));

    await mount();

    expect(glyph()).not.toBeNull();
    expect(glyph()?.querySelector('.topbar__badge')).not.toBeNull();
    expect(glyph()?.getAttribute('aria-label')).toBe('Shout-outs, 1 new');
  });

  it('stays dark when there is nothing new', async () => {
    await createTag('WRITER');
    await markShoutsSeen(NOW);
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout(NOW - 3600)]));

    await mount();

    expect(glyph()?.querySelector('.topbar__badge')).toBeNull();
    expect(glyph()?.getAttribute('aria-label')).toBe('Shout-outs');
  });

  it('goes out the moment the screen is opened', async () => {
    await createTag('WRITER');
    await markShoutsSeen(NOW - 3600);
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([shout(NOW - 60)]));

    await mount();
    expect(glyph()?.querySelector('.topbar__badge')).not.toBeNull();

    // What the shout-outs screen does when its first page lands.
    await act(async () => {
      await markShoutsSeen(NOW);
    });
    await settle(2);

    expect(glyph()?.querySelector('.topbar__badge')).toBeNull();
  });

  it('stays quiet when the wall cannot be reached', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await mount();

    expect(glyph()).not.toBeNull();
    expect(glyph()?.querySelector('.topbar__badge')).toBeNull();
  });
});
