import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A writer's page.
 *
 * Two things are pinned here. First the data path: this page used to ask for a
 * wall that was never built (`/writer/:id/flicks`), 404 every time, and quietly
 * fall back to reading posts one at a time — so it never had the writer's
 * standing at all. It asks for the writer now, and gets both halves in one go.
 *
 * Second the standing itself: how long they have been on the wall and how much
 * they have up, stated flatly, and NOT stated at all when the wall does not
 * know.
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

const { Writer } = await import('./Writer.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { onTheWallSince } = await import('../lib/reputation.js');
const { API_BASE } = await import('../lib/config.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SHOCK = 'a'.repeat(64);
const FLICK = '1'.repeat(64);

/** Long enough on the wall for all three dots. */
const FIRST_SEEN = NOW - 200 * DAY;

function answer(writer: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...(writer ? { writer } : {}),
    flicks: [
      {
        id: FLICK,
        url: 'https://media.example/one.webp',
        sha256: 'f'.repeat(64),
        writer: { pubkey: SHOCK, tag: 'SHOCK' },
        createdAt: NOW - 900,
        width: 900,
        height: 1200,
        caption: 'rooftop in the fog',
      },
    ],
    nextCursor: null,
  };
}

const SEEN = {
  pubkey: SHOCK,
  tag: 'SHOCK',
  mark: 'aa11bb',
  avatarSha256: null,
  city: 'sf-bay',
  firstSeen: FIRST_SEEN,
  updatedAt: NOW - 900,
  flickCount: 12,
  eventCount: 40,
  banned: false,
  crews: [],
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function answering(body: unknown, ok = true): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response) as unknown as typeof globalThis.fetch,
  );
}

function askedFor(): string[] {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
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
        <ToastProvider>
          <MemoryRouter initialEntries={[`/w/${SHOCK}`]}>
            <Routes>
              <Route path="/w/:pubkey" element={<Writer />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('a writer’s page', () => {
  it('asks the wall for the writer, not for a wall that was never built', async () => {
    await createTag('WRITER');
    answering(answer(SEEN));

    await mount();

    const asked = askedFor();
    expect(asked.some((url) => url.startsWith(`${API_BASE}/writer/${SHOCK}`))).toBe(true);
    for (const url of asked) {
      expect(url).not.toContain('/flicks');
    }
  });

  it('shows everything they have up out of the same answer', async () => {
    await createTag('WRITER');
    answering(answer(SEEN));

    await mount();

    expect(container.querySelector(`a[href="/f/${FLICK}"]`)).not.toBeNull();
    expect(container.textContent).toContain('rooftop in the fog');
    // The wall's name for them stands in when their own profile is unreachable.
    expect(container.querySelector('h2')?.textContent).toBe('SHOCK');
  });

  it('says how long they have been on the wall and how much they have up', async () => {
    await createTag('WRITER');
    answering(answer(SEEN));

    await mount();

    const standing = container.querySelector('.standing');
    expect(standing).not.toBeNull();
    expect(standing!.textContent).toContain(onTheWallSince(FIRST_SEEN)!);
    expect(standing!.textContent).toContain('12 up');
  });

  it('fills the dots by how long they have been around, and spells it out', async () => {
    await createTag('WRITER');
    answering(answer(SEEN));

    await mount();

    const dots = container.querySelector('.age-dots');
    expect(dots).not.toBeNull();
    expect(dots!.getAttribute('aria-label')).toBe('up for 6 months');
    expect(dots!.querySelectorAll('.age-dots__dot')).toHaveLength(3);
    expect(dots!.querySelectorAll('.age-dots__dot--on')).toHaveLength(3);
  });

  it('shows one dot for somebody who turned up last week', async () => {
    await createTag('WRITER');
    answering(answer({ ...SEEN, firstSeen: NOW - 9 * DAY }));

    await mount();

    const dots = container.querySelector('.age-dots');
    expect(dots!.getAttribute('aria-label')).toBe('up for 9 days');
    expect(dots!.querySelectorAll('.age-dots__dot--on')).toHaveLength(1);
  });

  it('says nothing at all when the wall does not know when they turned up', async () => {
    await createTag('WRITER');
    answering(answer({ ...SEEN, firstSeen: null, flickCount: null, eventCount: null }));

    await mount();

    expect(container.querySelector('.standing')).toBeNull();
    expect(container.querySelector('.age-dots')).toBeNull();
    expect(container.textContent).not.toContain('on the wall since');
  });

  it('still shows their wall when the wall knows nothing about them', async () => {
    await createTag('WRITER');
    answering(answer(null));

    await mount();

    expect(container.querySelector('.standing')).toBeNull();
    expect(container.querySelector(`a[href="/f/${FLICK}"]`)).not.toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('WRITER');
    answering(answer(SEEN));

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
