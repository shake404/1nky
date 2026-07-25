import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The happenings list.
 *
 * A board is ordered by what was said last; this screen is ordered by what is
 * about to happen, and the headings are the whole point — somebody scanning it
 * is deciding whether they are going this weekend. So the test checks the
 * headings, the dates on the rows, and that picking a city actually narrows the
 * read rather than filtering on screen.
 */

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Happenings } = await import('./Happenings.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const ID = (char: string): string => char.repeat(64);

/** Dates relative to right now, so the headings are stable whenever this runs. */
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

function happening(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID('a'),
    subject: 'Yard jam',
    excerpt: 'bring paint',
    writer: { pubkey: ID('b'), tag: 'SMOG' },
    createdAt: NOW - 3600,
    expiresAt: NOW + 30 * DAY,
    happeningAt: NOW + 2 * 3600,
    replyCount: 2,
    lastReplyAt: NOW - 600,
    boards: ['sf-bay', 'happening'],
    ...overrides,
  };
}

/** Answers the happenings read and the facet read, like the wall does. */
function wallFetch(rows: unknown[], cities: unknown[] = []): typeof globalThis.fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/explore/facets')) {
      return { ok: true, status: 200, json: async () => ({ cities }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ happenings: rows, nextCursor: null }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

let asked: string[] = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

beforeEach(() => {
  setActEnv(true);
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

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/happenings']}>
        <Happenings />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function headings(): string[] {
  return [...container.querySelectorAll('h3')].map((h) => h.textContent ?? '');
}

describe('the happenings list', () => {
  it('groups what is coming by when it goes down', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      wallFetch([
        happening({ id: ID('a'), happeningAt: NOW + 2 * 3600 }),
        happening({ id: ID('d'), subject: 'Wall meet', happeningAt: NOW + DAY + 3600 }),
        happening({ id: ID('e'), subject: 'Show', happeningAt: NOW + 40 * DAY }),
      ]),
    );

    await mount();

    expect(headings()).toContain('today');
    expect(headings()).toContain('tomorrow');
    // The far-out one gets a plain date rather than a bucket.
    expect(headings().some((h) => /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d/.test(h))).toBe(true);
    expect(container.querySelectorAll('a.thread')).toHaveLength(3);
  });

  it('links each row to the thread and stamps it with its date', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([happening()]));

    await mount();

    const link = container.querySelector(`a[href="/t/${ID('a')}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('Yard jam');
    expect(link!.querySelector('.when-chip')?.textContent).toBeTruthy();
    // The board it went up on is named; the marker slug never is.
    expect(link!.textContent).toContain('sf-bay');
    expect(link!.textContent).not.toContain('happening');
  });

  it('says what becomes of a happening without being asked', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([happening()]));

    await mount();

    expect(container.textContent).toContain('clears itself a week after');
  });

  it('narrows the read when a city is picked, and widens it again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      wallFetch([happening()], [{ slug: 'sf-bay', count: 4 }]),
    );

    await mount();
    expect(asked.some((url) => url.includes('/happenings') && url.includes('city='))).toBe(false);

    const chip = [...container.querySelectorAll('button.chip')].find(
      (b) => b.textContent?.startsWith('sf-bay'),
    );
    expect(chip).toBeDefined();
    await act(async () => {
      (chip as HTMLButtonElement).click();
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(asked.some((url) => url.includes('/happenings') && url.includes('city=sf-bay'))).toBe(true);

    // Tapping the same chip again is how you get back to everywhere.
    await act(async () => {
      (chip as HTMLButtonElement).click();
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const last = asked.filter((url) => url.includes('/happenings')).at(-1) ?? '';
    expect(last).not.toContain('city=');
  });

  it('invites the first one when nothing is on', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(wallFetch([]));

    await mount();

    expect(container.textContent).toContain('Nothing on yet.');
    expect(container.querySelector('a[href="/boards"]')).not.toBeNull();
  });

  it('still shows the page when the wall cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    await mount();

    expect(container.textContent).toContain('Nothing on yet.');
    expect(container.textContent).toContain('Could not reach the wall.');
  });

  it('says nothing from the jargon blocklist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      wallFetch([happening()], [{ slug: 'sf-bay', count: 4 }]),
    );

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
