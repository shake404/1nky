import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalWall,
  findWall,
  loadWalls,
  resetWallsCache,
  searchWalls,
  WALL_ALIASES,
  wallLabel,
  type Wall,
} from './walls.js';

/**
 * The wall gazetteer — the layer that stops one city minting four walls.
 *
 * Everything here is local: the dataset ships from our own origin and the search
 * is a substring match over an array. There is no geocoding API and there never
 * will be one, because a typeahead that phones a third party tells that third
 * party which city a writer was about to name.
 */

const wall = (slug: string, name: string, region: string, country: string, rank: number): Wall => ({
  slug,
  name,
  region,
  country,
  rank,
});

const WALLS: Wall[] = [
  wall('london', 'London', 'England', 'GB', 10),
  wall('london-ca', 'London', 'Ontario', 'CA', 900),
  wall('san-francisco', 'San Francisco', 'California', 'US', 676),
  wall('san-jose', 'San Jose', 'California', 'US', 700),
  wall('santiago', 'Santiago', 'Santiago Metropolitan', 'CL', 100),
  wall('new-york-city', 'New York City', 'New York', 'US', 20),
  wall('newcastle', 'Newcastle', 'New South Wales', 'AU', 800),
  wall('koln', 'Köln', 'North Rhine-Westphalia', 'DE', 300),
  wall('oakland', 'Oakland', 'California', 'US', 850),
  wall('ramallah', 'Ramallah', 'West Bank', 'PS', 2452),
];

const PAYLOAD = {
  _attribution: 'GeoNames, CC BY 4.0',
  version: 1,
  fields: ['slug', 'name', 'region', 'country', 'rank'],
  regions: ['England', 'Ontario', 'California', 'West Bank'],
  countries: { GB: 'United Kingdom', CA: 'Canada', US: 'United States', PS: 'Palestine' },
  cities: [
    ['london', 'London', 0, 'GB', 10],
    ['london-ca', 'London', 1, 'CA', 900],
    ['san-francisco', 'San Francisco', 2, 'US', 676],
    ['ramallah', 'Ramallah', 3, 'PS', 2452],
    ['nowhere', 'Nowhere', -1, 'XX', 9999],
  ],
};

beforeEach(() => {
  resetWallsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WALL_ALIASES', () => {
  it('ships the nicknames the sprawl was made of', () => {
    expect(WALL_ALIASES['sf']).toBe('san-francisco');
    expect(WALL_ALIASES['sf-bay']).toBe('san-francisco');
    expect(WALL_ALIASES['frisco']).toBe('san-francisco');
    expect(WALL_ALIASES['nyc']).toBe('new-york-city');
  });

  it('carries no bookkeeping keys into the map', () => {
    for (const key of Object.keys(WALL_ALIASES)) expect(key.startsWith('_')).toBe(false);
  });

  it('has no alias pointing at itself', () => {
    for (const [alias, target] of Object.entries(WALL_ALIASES)) expect(target).not.toBe(alias);
  });
});

describe('canonicalWall', () => {
  it('folds every spelling of one city onto one slug', () => {
    for (const raw of ['sf', 'SF', 'sf-bay', 'SF Bay', 'frisco', ' San Francisco ']) {
      expect(canonicalWall(raw)).toBe('san-francisco');
    }
  });

  it('folds the renamed and anglicised cities too', () => {
    expect(canonicalWall('kiev')).toBe('kyiv');
    expect(canonicalWall('bombay')).toBe('mumbai');
    expect(canonicalWall('cologne')).toBe('koln');
  });

  it('leaves a wall it has never heard of alone', () => {
    expect(canonicalWall('walla-walla')).toBe('walla-walla');
  });

  it('leaves the feedback wall alone — it is an ordinary slug', () => {
    expect(canonicalWall('holler')).toBe('holler');
  });

  it('never touches the happening marker', () => {
    expect(canonicalWall('happening')).toBe('happening');
  });

  it('still slugifies when nothing matches', () => {
    expect(canonicalWall('  Walla Walla!! ')).toBe('walla-walla');
  });
});

describe('loadWalls', () => {
  const stub = (payload: unknown, ok = true) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        ({
          ok,
          json: async () => payload,
        }) as unknown as Response,
    );

  it('reads the dataset from our own origin, never a third party', async () => {
    const fetchSpy = stub(PAYLOAD);
    await loadWalls();
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url.startsWith('/')).toBe(true);
    expect(url).toBe('/cities.json');
  });

  it('expands the interned regions back onto each wall', async () => {
    stub(PAYLOAD);
    const walls = await loadWalls();
    expect(walls.find((w) => w.slug === 'london')?.region).toBe('England');
    expect(walls.find((w) => w.slug === 'london-ca')?.region).toBe('Ontario');
    expect(walls.find((w) => w.slug === 'ramallah')?.region).toBe('West Bank');
  });

  it('tolerates a wall with no region', async () => {
    stub(PAYLOAD);
    const walls = await loadWalls();
    expect(walls.find((w) => w.slug === 'nowhere')?.region).toBe('');
  });

  it('fetches once and reuses the result', async () => {
    const fetchSpy = stub(PAYLOAD);
    await loadWalls();
    await loadWalls();
    await loadWalls();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchSpy = stub(PAYLOAD);
    await Promise.all([loadWalls(), loadWalls(), loadWalls()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty list rather than breaking the form', async () => {
    stub(PAYLOAD, false);
    expect(await loadWalls()).toEqual([]);
  });

  it('degrades to an empty list when the fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await loadWalls()).toEqual([]);
  });

  it('retries after a failure rather than caching the empty list forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await loadWalls()).toEqual([]);
    vi.restoreAllMocks();
    stub(PAYLOAD);
    expect((await loadWalls()).length).toBeGreaterThan(0);
  });

  it('ignores malformed rows instead of throwing', async () => {
    stub({ ...PAYLOAD, cities: [['ok', 'Ok', -1, 'US', 1], 'junk', [], [42], null] });
    const walls = await loadWalls();
    expect(walls.map((w) => w.slug)).toEqual(['ok']);
  });

  it('survives a payload that is not the shape we expect', async () => {
    stub({ nope: true });
    expect(await loadWalls()).toEqual([]);
  });
});

describe('searchWalls', () => {
  it('finds a city by the start of its name', () => {
    expect(searchWalls(WALLS, 'san fran')[0]?.slug).toBe('san-francisco');
  });

  it('finds a city by its slug', () => {
    expect(searchWalls(WALLS, 'san-francisco')[0]?.slug).toBe('san-francisco');
  });

  it('finds a city by a nickname, so typing sf offers San Francisco', () => {
    expect(searchWalls(WALLS, 'sf')[0]?.slug).toBe('san-francisco');
    expect(searchWalls(WALLS, 'frisco')[0]?.slug).toBe('san-francisco');
    expect(searchWalls(WALLS, 'nyc')[0]?.slug).toBe('new-york-city');
  });

  it('finds the anglicised spelling of a locally-named city', () => {
    expect(searchWalls(WALLS, 'cologne')[0]?.slug).toBe('koln');
  });

  it('matches through diacritics both ways', () => {
    expect(searchWalls(WALLS, 'koln')[0]?.slug).toBe('koln');
    expect(searchWalls(WALLS, 'köln')[0]?.slug).toBe('koln');
  });

  it('ranks the bigger city first when two share a name', () => {
    const hits = searchWalls(WALLS, 'london');
    expect(hits[0]?.slug).toBe('london');
    expect(hits[1]?.slug).toBe('london-ca');
  });

  it('finds cities by region, so "california" offers the Californian walls', () => {
    const slugs = searchWalls(WALLS, 'california').map((w) => w.slug);
    expect(slugs).toContain('san-francisco');
    expect(slugs).toContain('oakland');
  });

  it('prefers a name match over a region match', () => {
    // "New" starts New York City's name and appears in New South Wales.
    expect(searchWalls(WALLS, 'new')[0]?.slug).toBe('new-york-city');
  });

  it('matches a word inside the name, not just the first one', () => {
    expect(searchWalls(WALLS, 'york').map((w) => w.slug)).toContain('new-york-city');
  });

  it('ignores case, punctuation and surrounding space', () => {
    expect(searchWalls(WALLS, '  SAN FRANCISCO!  ')[0]?.slug).toBe('san-francisco');
  });

  it('returns nothing for an empty query rather than the whole world', () => {
    expect(searchWalls(WALLS, '')).toEqual([]);
    expect(searchWalls(WALLS, '   ')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchWalls(WALLS, 'zzzzzz')).toEqual([]);
  });

  it('caps how many it offers', () => {
    expect(searchWalls(WALLS, 'a', 3).length).toBeLessThanOrEqual(3);
  });

  it('never offers the same wall twice, however many ways it matched', () => {
    const hits = searchWalls(WALLS, 'san');
    expect(new Set(hits.map((w) => w.slug)).size).toBe(hits.length);
  });
});

describe('wallLabel', () => {
  it('reads as a place, with the region for context', () => {
    expect(wallLabel(WALLS[0] as Wall)).toBe('London, England');
  });

  it('falls back to the country code when there is no region', () => {
    expect(wallLabel(wall('nowhere', 'Nowhere', '', 'XX', 1))).toBe('Nowhere, XX');
  });

  it('never says anything about datasets or coordinates', () => {
    const label = wallLabel(WALLS[2] as Wall);
    expect(label).toBe('San Francisco, California');
  });
});

describe('findWall', () => {
  it('finds a wall by its canonical slug', () => {
    expect(findWall(WALLS, 'san-francisco')?.name).toBe('San Francisco');
  });

  it('canonicalizes first, so an alias finds the real wall', () => {
    expect(findWall(WALLS, 'sf')?.slug).toBe('san-francisco');
    expect(findWall(WALLS, 'SF Bay')?.slug).toBe('san-francisco');
  });

  it('returns null for a wall the dataset does not carry', () => {
    expect(findWall(WALLS, 'walla-walla')).toBeNull();
    expect(findWall(WALLS, '')).toBeNull();
  });
});
