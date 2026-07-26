import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read-side convergence: one city, one wall, whatever address you arrived at.
 *
 * `/b/sf` has to land on `/b/san-francisco`, using the same alias map the
 * posting form uses, or the sprawl just moves from the write side to the read
 * side. What must NOT happen is any attempt to rewrite history: posts already
 * signed with `sf-bay` keep that tag forever — they are signed events. Their
 * old feed stays readable at its own address; new posts stop landing there.
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
const { NewThread } = await import('./NewThread.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
/** Where the router ended up after everything settled. */
let landed = '';

function Probe(): null {
  const location = useLocation();
  landed = location.pathname + location.search;
  return null;
}

beforeEach(async () => {
  setActEnv(true);
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  resetIgnoredCache();
  landed = '';
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      ({
        ok: true,
        json: async () => ({ board: null, threads: [], cursor: null, flicks: [] }),
      }) as unknown as Response,
  );
  await createTag('SHOCK');
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  setActEnv(false);
  vi.restoreAllMocks();
});

async function visit(path: string): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Probe />
            <Routes>
              <Route path="/b/:slug" element={<Board />} />
              <Route path="/b/:slug/new" element={<NewThread />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('/b/:slug — alias redirect', () => {
  it('lands /b/sf on /b/san-francisco', async () => {
    await visit('/b/sf');
    expect(landed).toBe('/b/san-francisco');
  });

  it('lands every other spelling of the city on the same wall', async () => {
    for (const alias of ['sf-bay', 'frisco', 'san-fran']) {
      await visit(`/b/${alias}`);
      expect(landed).toBe('/b/san-francisco');
      act(() => root!.unmount());
      root = null;
    }
  });

  it('folds the renamed cities too', async () => {
    await visit('/b/kiev');
    expect(landed).toBe('/b/kyiv');
  });

  it('stays put on a canonical wall', async () => {
    await visit('/b/oakland');
    expect(landed).toBe('/b/oakland');
  });

  it('stays put on a wall no dataset carries', async () => {
    await visit('/b/walla-walla');
    expect(landed).toBe('/b/walla-walla');
  });

  it('never redirects the feedback wall', async () => {
    await visit('/b/holler');
    expect(landed).toBe('/b/holler');
  });

  it('never redirects the happening marker', async () => {
    await visit('/b/happening');
    expect(landed).toBe('/b/happening');
  });

  it('does not fetch the alias board before leaving it', async () => {
    await visit('/b/sf');
    for (const call of vi.mocked(globalThis.fetch).mock.calls) {
      expect(String(call[0])).not.toContain('sf');
    }
  });
});

describe('/b/:slug/new — alias redirect', () => {
  it('starts a thread on the canonical wall', async () => {
    await visit('/b/sf/new');
    expect(landed).toBe('/b/san-francisco/new');
  });

  it('keeps ?happening=1 across the hop', async () => {
    await visit('/b/nyc/new?happening=1');
    expect(landed).toBe('/b/new-york-city/new?happening=1');
  });

  it('stays put on a canonical wall', async () => {
    await visit('/b/oakland/new');
    expect(landed).toBe('/b/oakland/new');
  });
});
