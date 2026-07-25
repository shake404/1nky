import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchExplore, fetchExploreFacets, exploreUrl } from './explore.js';

const API = 'http://localhost:3001';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}

describe('exploreUrl', () => {
  it('emits bare facet values and a readable cursor', () => {
    const url = new URL(exploreUrl({ type: ['throwie', 'piece'], surface: ['street'], legal: true }, 'abc'));
    expect(url.searchParams.getAll('type')).toEqual(['throwie', 'piece']);
    expect(url.searchParams.getAll('surface')).toEqual(['street']);
    expect(url.searchParams.get('legal')).toBe('true');
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(url.pathname).toBe('/explore');
  });

  it('omits facets that are not set', () => {
    const url = new URL(exploreUrl({}, null));
    expect(url.search).toBe('');
  });
});

describe('fetchExploreFacets', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        cities: [{ slug: 'sf-bay', count: 12 }, { slug: 'oakland', count: 3 }],
        types: [{ slug: 'throwie', count: 7 }, { slug: 'piece', count: 5 }],
        surfaces: [{ slug: 'street', count: 9 }],
        regions: [{ slug: 'bay-area', count: 15 }],
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('parses the four facet groups into chip options', async () => {
    const facets = await fetchExploreFacets();
    expect(facets.cities.map((c) => c.slug)).toEqual(['sf-bay', 'oakland']);
    expect(facets.types.map((t) => t.slug)).toEqual(['throwie', 'piece']);
    expect(facets.surfaces[0]).toEqual({ slug: 'street', count: 9 });
    expect(facets.regions[0]).toEqual({ slug: 'bay-area', count: 15 });
  });
});

describe('fetchExplore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the filtered wall the API answered with', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ flicks: [], nextCursor: 'next' }));

    const page = await fetchExplore({ type: ['throwie'], surface: ['street'] }, null);

    expect(page.degraded).toBe(false);
    expect(page.cursor).toBe('next');
    // The query actually asked the explore endpoint with the bare facets.
    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/explore');
    expect(calledUrl.searchParams.getAll('type')).toEqual(['throwie']);
    expect(calledUrl.searchParams.getAll('surface')).toEqual(['street']);
  });

  it('degrades to the feed and client-filters when the API is unreachable', async () => {
    vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: URL | RequestInfo, _init?: RequestInit) => {
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : (input as Request).url ?? 'https://x/');
        if (url.pathname === '/explore') return notFound();
        // Simulate /feed returning one matching + one non-matching flick.
        return jsonResponse({
          flicks: [
            {
              id: 'a'.repeat(64),
              mediaType: 'flick',
              createdAt: 1,
              url: 'https://m/x',
              sha256: 'c'.repeat(64),
              width: 1,
              height: 1,
              caption: '',
              boards: ['type-throwie', 'surface-street'],
              writer: { pubkey: 'b'.repeat(64), tag: null },
            },
            {
              id: 'd'.repeat(64),
              mediaType: 'flick',
              createdAt: 1,
              url: 'https://m/y',
              sha256: 'c'.repeat(64),
              width: 1,
              height: 1,
              caption: '',
              boards: ['type-piece'],
              writer: { pubkey: 'b'.repeat(64), tag: null },
            },
          ],
          cursor: null,
        });
      });

    const page = await fetchExplore({ type: ['throwie'], surface: ['street'] }, null);
    expect(page.degraded).toBe(true);
    expect(page.flicks).toHaveLength(1);
    expect(page.flicks[0]?.id).toBe('a'.repeat(64));
  });
});