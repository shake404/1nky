import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boards hub.
 *
 * A board's slug IS its name — writers say "sf-bay", not "San Francisco Bay
 * Area board" — so the card leads with the slug and the card is the link. The
 * empty state has to invite the first post rather than read as an error.
 */

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Boards } = await import('./Boards.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const NOW = Math.floor(Date.now() / 1000);

const CITY_BOARDS = [
  {
    slug: 'sf-bay',
    title: 'sf-bay',
    kind: 'city',
    createdAt: NOW - 90_000,
    flickCount: 12,
    threadCount: 3,
    latestAt: NOW - 7200,
  },
  {
    slug: 'oakland',
    title: 'The Town',
    kind: 'city',
    createdAt: NOW - 40_000,
    flickCount: 1,
    threadCount: 1,
    latestAt: null,
  },
];

const OTHER_BOARDS = [{ slug: 'bay-area', title: 'bay-area', kind: 'region', createdAt: NOW, flickCount: 5, threadCount: 0, latestAt: NOW }];

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

/** Answers `/boards?kind=city` and `/boards` separately, like the wall does. */
function boardsFetch(cities: unknown[], others: unknown[]): typeof globalThis.fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes('kind=city') ? { boards: cities } : { boards: [...cities, ...others] };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof globalThis.fetch;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  setActEnv(true);
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
      <MemoryRouter initialEntries={['/boards']}>
        <Boards />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the boards hub', () => {
  it('puts every city board up as a card that links to the board', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch(CITY_BOARDS, []));

    await mount();

    const cards = container.querySelectorAll('a.board-card');
    expect(cards).toHaveLength(2);

    const sf = container.querySelector('a[href="/b/sf-bay"]');
    expect(sf).not.toBeNull();
    expect(sf!.textContent).toContain('sf-bay');
    // Counts, in the writer's words.
    expect(sf!.textContent).toContain('3 threads');
    expect(sf!.textContent).toContain('12 flicks');

    // A board with a title that is genuinely different shows both.
    const oakland = container.querySelector('a[href="/b/oakland"]');
    expect(oakland!.textContent).toContain('oakland');
    expect(oakland!.textContent).toContain('The Town');
    // Nothing has landed on it yet.
    expect(oakland!.textContent).toContain('nothing up yet');
  });

  it('does not repeat a title that is only the slug re-cased', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      boardsFetch([{ ...CITY_BOARDS[0], title: 'SF-BAY' }], []),
    );

    await mount();

    const sf = container.querySelector('a[href="/b/sf-bay"]');
    expect(sf!.querySelector('.board-card__title')).toBeNull();
  });

  it('counts a single thread and a single flick in the singular', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch([CITY_BOARDS[1]], []));

    await mount();

    const oakland = container.querySelector('a[href="/b/oakland"]');
    expect(oakland!.textContent).toContain('1 thread');
    expect(oakland!.textContent).toContain('1 flick');
    expect(oakland!.textContent).not.toContain('1 threads');
  });

  it('tucks anything that is not a city into its own quiet row', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch(CITY_BOARDS, OTHER_BOARDS));

    await mount();

    expect(container.textContent).toContain('Everything else');
    const other = container.querySelector('a[href="/b/bay-area"]');
    expect(other).not.toBeNull();
    // It is not one of the big city cards.
    expect(other!.classList.contains('board-card')).toBe(false);
  });

  it('keeps a permanent way to holler, even with nothing claimed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch([], []));

    await mount();

    const holler = container.querySelector('a[href="/holler"]');
    expect(holler).not.toBeNull();
    expect(holler!.textContent).toContain('Holler at us');
  });

  it('does not list the holler board twice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      boardsFetch(CITY_BOARDS, [
        { slug: 'holler', title: 'holler', kind: 'feedback', createdAt: NOW, flickCount: 0, threadCount: 4, latestAt: NOW },
      ]),
    );

    await mount();

    // The quiet row is for boards without a front door of their own.
    expect(container.querySelector('a[href="/b/holler"]')).toBeNull();
    expect(container.querySelector('a[href="/holler"]')).not.toBeNull();
  });

  it('invites the first post when nobody has claimed a wall', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch([], []));

    await mount();

    expect(container.textContent).toContain('No walls claimed yet.');
    expect(container.textContent).toContain('Start one by posting to it.');
    expect(container.querySelector('a[href="/post"]')).not.toBeNull();
  });

  it('still shows the page when the wall cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    await mount();

    expect(container.textContent).toContain('No walls claimed yet.');
    expect(container.textContent).toContain('Could not reach the wall.');
  });

  it('says nothing from the jargon blocklist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(boardsFetch(CITY_BOARDS, OTHER_BOARDS));

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
