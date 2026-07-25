import { API_BASE } from './config.js';
import { fetchFeed, parseFeedResponse, type Flick, type FeedPage } from './feed.js';

/**
 * Explore — browse the unified media feed by location and by type, combined.
 *
 * Facet values in URLs are BARE (`type-throwie` is sent as `type=throwie`); the
 * API adds the `type-` prefix server-side so the URL stays readable (design
 * doc Part 3.5). AND across facets, OR within a repeated facet
 * (`?type=throwie&type=piece`).
 */

export interface FacetOption {
  slug: string;
  count: number;
}

export interface ExploreFacets {
  cities: FacetOption[];
  types: FacetOption[];
  surfaces: FacetOption[];
  regions: FacetOption[];
}

export interface ExploreFilter {
  city?: string[];
  type?: string[];
  surface?: string[];
  region?: string[];
  legal?: boolean;
}

export interface ExplorePage {
  flicks: Flick[];
  cursor: string | null;
  degraded: boolean;
}

const EMPTY_FACETS: ExploreFacets = { cities: [], types: [], surfaces: [], regions: [] };

function parseFacets(body: unknown): ExploreFacets {
  if (typeof body !== 'object' || body === null) return EMPTY_FACETS;
  const record = body as Record<string, unknown>;
  const pick = (key: string): FacetOption[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .map((m) => ({
            slug: typeof m['slug'] === 'string' ? m['slug'] : '',
            count: typeof m['count'] === 'number' ? m['count'] : 0,
          }))
          .filter((o) => o.slug)
      : [];
  return {
    cities: pick('cities'),
    types: pick('types'),
    surfaces: pick('surfaces'),
    regions: pick('regions'),
  };
}

/** `GET /explore/facets` — the chip-picker counts. Degrades to empty chips. */
export async function fetchExploreFacets(signal?: AbortSignal): Promise<ExploreFacets> {
  try {
    const response = await fetch(`${API_BASE}/explore/facets`, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error('degrade');
    return parseFacets(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return EMPTY_FACETS;
  }
}

/** Build the `?city=&type=&surface=&region=&legal=&cursor=` query string. */
export function exploreUrl(filter: ExploreFilter, cursor: string | null): string {
  const url = new URL(`${API_BASE}/explore`);
  const push = (key: string, values: string[] | undefined): void => {
    if (!values) return;
    for (const v of values) if (v) url.searchParams.append(key, v);
  };
  push('city', filter.city);
  push('type', filter.type);
  push('surface', filter.surface);
  push('region', filter.region);
  if (filter.legal) url.searchParams.set('legal', 'true');
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

/**
 * `GET /explore?…` — the filtered wall, keyset-paginated.
 *
 * Degrades to the unfiltered `GET /feed` and filters client-side on
 * `flick.boards`, exactly the Tier-0 fallback the design doc names — degraded
 * (no server-side pagination-after-filter, no facet counts) but real.
 */
export async function fetchExplore(filter: ExploreFilter, cursor: string | null, signal?: AbortSignal): Promise<ExplorePage> {
  try {
    const response = await fetch(exploreUrl(filter, cursor), {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error('degrade');
    const parsed = parseFeedResponse(await response.json());
    return { flicks: parsed.flicks, cursor: parsed.cursor, degraded: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return degradedExplore(filter, cursor);
  }
}

/** Client-side filter on the relay-fallback facet slugs (`type-throwie` etc). */
function matchesFilter(flick: Flick, filter: ExploreFilter): boolean {
  const boards = flick.boards ?? [];
  if (filter.type?.length) {
    const wanted = new Set(filter.type.map((t) => `type-${t}`));
    if (!boards.some((b) => wanted.has(b))) return false;
  }
  if (filter.surface?.length) {
    const wanted = new Set(filter.surface.map((s) => `surface-${s}`));
    if (!boards.some((b) => wanted.has(b))) return false;
  }
  if (filter.region?.length) {
    const wanted = new Set(filter.region.map((r) => `region-${r}`));
    if (!boards.some((b) => wanted.has(b))) return false;
  }
  if (filter.city?.length) {
    const wanted = new Set(filter.city);
    if (!boards.some((b) => wanted.has(b))) return false;
  }
  if (filter.legal) {
    if (!boards.includes('legal-permission')) return false;
  }
  return true;
}

async function degradedExplore(filter: ExploreFilter, cursor: string | null): Promise<ExplorePage> {
  const page: FeedPage = await fetchFeed(cursor);
  const flicks = page.flicks.filter((f) => matchesFilter(f, filter));
  return { flicks, cursor: page.cursor, degraded: true };
}