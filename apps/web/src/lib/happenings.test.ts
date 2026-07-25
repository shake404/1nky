import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is coming up.
 *
 * Two things are worth pinning here and nothing else is: the shaping (a row
 * without a date is not a happening, and an ignored writer's jam does not show
 * up) and the words — "this weekend" has to mean the weekend a writer is
 * standing next to, or the list is lying about the one thing it is for.
 */

vi.mock('./mute.js', () => ({
  isIgnored: (pubkey: string) => pubkey === 'c'.repeat(64),
}));

const {
  fetchHappenings,
  groupHappenings,
  happeningGroup,
  HAPPENING_CLEARS_COPY,
  parseHappeningsResponse,
  runsLine,
  whenText,
} = await import('./happenings.js');

const ID = (char: string): string => char.repeat(64);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID('a'),
    subject: 'Yard jam',
    excerpt: 'bring paint',
    writer: { pubkey: ID('b'), tag: 'SMOG' },
    createdAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
    happeningAt: 1_790_000_000,
    replyCount: 3,
    lastReplyAt: 1_700_000_500,
    boards: ['sf-bay', 'happening'],
    ...overrides,
  };
}

describe('parseHappeningsResponse', () => {
  it('reads a row, its date and the boards it went up on', () => {
    const page = parseHappeningsResponse({ happenings: [row()], nextCursor: 'next' });

    expect(page.cursor).toBe('next');
    expect(page.happenings).toHaveLength(1);
    const first = page.happenings[0]!;
    expect(first.id).toBe(ID('a'));
    expect(first.subject).toBe('Yard jam');
    expect(first.excerpt).toBe('bring paint');
    expect(first.happeningAt).toBe(1_790_000_000);
    expect(first.boards).toEqual(['sf-bay', 'happening']);
    expect(first.replyCount).toBe(3);
    expect(first.writer.tag).toBe('SMOG');
    // The mark is derived from the id, so it is always there.
    expect(first.writer.mark).toHaveLength(6);
  });

  it('throws out anything without a real date on it', () => {
    const page = parseHappeningsResponse({
      happenings: [
        row({ id: ID('a'), happeningAt: null }),
        row({ id: ID('d'), happeningAt: 0 }),
        row({ id: ID('e') }),
        { nonsense: true },
      ],
    });

    expect(page.happenings.map((h) => h.id)).toEqual([ID('e')]);
  });

  it('drops a happening put on by somebody you ignore', () => {
    const page = parseHappeningsResponse({
      happenings: [row({ id: ID('e'), writer: { pubkey: ID('c') } }), row({ id: ID('f') })],
    });

    expect(page.happenings.map((h) => h.id)).toEqual([ID('f')]);
  });

  it('reads junk as an empty list rather than throwing', () => {
    expect(parseHappeningsResponse(null)).toEqual({ happenings: [], cursor: null });
    expect(parseHappeningsResponse({ happenings: 'nope' })).toEqual({ happenings: [], cursor: null });
    expect(parseHappeningsResponse({ happenings: [row()] }).cursor).toBeNull();
  });
});

describe('fetchHappenings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for a page, narrowed to a city when one is picked', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ happenings: [row()] }) } as Response;
    }) as unknown as typeof globalThis.fetch);

    const page = await fetchHappenings({ city: 'sf-bay', cursor: 'abc', limit: 10 });

    expect(page.happenings).toHaveLength(1);
    expect(seen[0]).toContain('/happenings?');
    expect(seen[0]).toContain('city=sf-bay');
    expect(seen[0]).toContain('limit=10');
    expect(seen[0]).toContain('cursor=abc');
  });

  it('leaves the city out when there is none', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ happenings: [] }) } as Response;
    }) as unknown as typeof globalThis.fetch);

    await fetchHappenings();

    expect(seen[0]).not.toContain('city=');
    expect(seen[0]).toContain('limit=30');
  });

  it('says it could not read the wall rather than inventing a page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    await expect(fetchHappenings()).rejects.toThrow();
  });
});

// Fixed points, all in the machine's own clock so the tests read the same
// everywhere: 2026-07-29 is a WEDNESDAY.
const WED = new Date(2026, 6, 29, 12, 0, 0).getTime() / 1000;

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0).getTime() / 1000;
}

describe('whenText', () => {
  it('writes the date the way a flyer does', () => {
    expect(whenText(at(2026, 7, 1), WED)).toBe('Sat Aug 1');
  });

  it('adds the time of day when there is one', () => {
    expect(whenText(at(2026, 7, 1, 20, 0), WED)).toBe('Sat Aug 1, 8pm');
    expect(whenText(at(2026, 7, 1, 20, 30), WED)).toBe('Sat Aug 1, 8:30pm');
    expect(whenText(at(2026, 7, 1, 9, 5), WED)).toBe('Sat Aug 1, 9:05am');
    expect(whenText(at(2026, 7, 1, 12, 0), WED)).toBe('Sat Aug 1, 12pm');
  });

  it('adds the year only when it is a different one', () => {
    expect(whenText(at(2027, 0, 2), WED)).toBe('Sat Jan 2 2027');
    expect(whenText(at(2026, 11, 25), WED)).toBe('Fri Dec 25');
  });
});

describe('runsLine', () => {
  it('says when it runs and what becomes of it', () => {
    expect(runsLine(at(2026, 7, 1), WED)).toBe('runs Sat Aug 1 · gone a week after');
  });

  it('never says anything the copy deck would not', () => {
    expect(HAPPENING_CLEARS_COPY).toBe('clears itself a week after');
  });
});

describe('happeningGroup', () => {
  it('names the near days outright', () => {
    expect(happeningGroup(at(2026, 6, 29, 20), WED)).toBe('today');
    expect(happeningGroup(at(2026, 6, 30, 20), WED)).toBe('tomorrow');
  });

  it('calls the Saturday and Sunday ahead of it the weekend', () => {
    expect(happeningGroup(at(2026, 7, 1, 20), WED)).toBe('this weekend');
    expect(happeningGroup(at(2026, 7, 2, 14), WED)).toBe('this weekend');
  });

  it('gives a weekday inside this week its own date', () => {
    // Friday of the same week — "this week" would tell nobody anything.
    expect(happeningGroup(at(2026, 6, 31, 19), WED)).toBe('Fri Jul 31');
  });

  it('sweeps the following week up under one heading', () => {
    expect(happeningGroup(at(2026, 7, 5), WED)).toBe('next week');
    expect(happeningGroup(at(2026, 7, 9), WED)).toBe('next week');
  });

  it('falls back to the plain date once it is further out than that', () => {
    expect(happeningGroup(at(2026, 7, 15), WED)).toBe('Sat Aug 15');
  });

  it('says a thing that has already started is under way', () => {
    expect(happeningGroup(at(2026, 6, 28, 20), WED)).toBe('under way');
  });

  it('has no weekend left to point at on a Sunday', () => {
    const sunday = at(2026, 7, 2, 12);
    // The Saturday six days later is next week's, and says so.
    expect(happeningGroup(at(2026, 7, 8), sunday)).toBe('next week');
  });
});

describe('groupHappenings', () => {
  it('keeps the wall’s order and does not open a heading twice', () => {
    const list = parseHappeningsResponse({
      happenings: [
        row({ id: ID('a'), happeningAt: at(2026, 6, 29, 20) }),
        row({ id: ID('b'), happeningAt: at(2026, 7, 1, 20) }),
        row({ id: ID('d'), happeningAt: at(2026, 7, 2, 12) }),
        row({ id: ID('e'), happeningAt: at(2026, 7, 6, 12) }),
      ],
    }).happenings;

    const groups = groupHappenings(list, WED);

    expect(groups.map((g) => g.label)).toEqual(['today', 'this weekend', 'next week']);
    expect(groups[1]?.happenings.map((h) => h.id)).toEqual([ID('b'), ID('d')]);
  });

  it('has nothing to group when there is nothing on', () => {
    expect(groupHappenings([], WED)).toEqual([]);
  });
});
