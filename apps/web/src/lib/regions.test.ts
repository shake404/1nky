import { describe, expect, it } from 'vitest';

import {
  canonicalRegion,
  expandRegion,
  findRegion,
  REGIONS,
  REGION_ALIASES,
  REGION_SUGGESTION_LIMIT,
  regionLabel,
  searchRegions,
  type Region,
} from './regions.js';

/**
 * The region gazetteer — the layer that stops one scene minting four region tags.
 *
 * Mirrors the wall gazetteer (`walls.test.ts`): the dataset is bundled (no fetch,
 * no third party), the search is a substring match over an array, and the alias
 * map folds the nicknames writers type onto one canonical slug. Where the walls
 * list is fetched on demand because it is ~2.5k cities, the region list is small
 * enough (~90) to ride in the bundle.
 */

const region = (slug: string, name: string): Region => ({ slug, name });

const REGIONS_FIXTURE: Region[] = [
  region('bay-area', 'Bay Area'),
  region('socal', 'Southern California'),
  region('pnw', 'Pacific Northwest'),
  region('tri-state', 'Tri-State Area'),
  region('greater-sao-paulo', 'Greater São Paulo'),
  region('scandinavia', 'Scandinavia'),
  region('randstad', 'Randstad'),
];

describe('REGION_ALIASES', () => {
  it('ships the nicknames the sprawl was made of', () => {
    expect(REGION_ALIASES['the-bay']).toBe('bay-area');
    expect(REGION_ALIASES['bay']).toBe('bay-area');
    expect(REGION_ALIASES['sf-bay-area']).toBe('bay-area');
    expect(REGION_ALIASES['so-cal']).toBe('socal');
    expect(REGION_ALIASES['pacific-northwest']).toBe('pnw');
    expect(REGION_ALIASES['new-york-metro']).toBe('tri-state');
  });

  it('carries no bookkeeping keys into the map', () => {
    for (const key of Object.keys(REGION_ALIASES)) expect(key.startsWith('_')).toBe(false);
  });

  it('has no alias pointing at itself', () => {
    for (const [alias, target] of Object.entries(REGION_ALIASES)) expect(target).not.toBe(alias);
  });

  it('points every alias at a real region we ship', () => {
    const known = new Set(REGIONS.map((r) => r.slug));
    for (const target of Object.values(REGION_ALIASES)) {
      expect(known.has(target)).toBe(true);
    }
  });
});

describe('REGIONS', () => {
  it('ships a hand-curated set, between 60 and 100 regions', () => {
    expect(REGIONS.length).toBeGreaterThanOrEqual(60);
    expect(REGIONS.length).toBeLessThanOrEqual(100);
  });

  it('carries the scenes the spec names', () => {
    const slugs = new Set(REGIONS.map((r) => r.slug));
    for (const slug of [
      'bay-area',
      'socal',
      'norcal',
      'pnw',
      'tri-state',
      'new-england',
      'midwest',
      'dirty-south',
      'gulf-coast',
      'front-range',
      'rust-belt',
      'dmv',
      'inland-empire',
      'low-countries',
      'ruhr',
      'rhine-main',
      'ile-de-france',
      'greater-london',
      'midlands',
      'randstad',
      'kansai',
      'kanto',
      'pearl-river-delta',
      'gta',
      'cdmx-metro',
      'greater-sao-paulo',
      'rio-metro',
      'greater-buenos-aires',
      'greater-melbourne',
      'greater-sydney',
    ]) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  it('gives every region a slug and a name, and no two regions share a slug', () => {
    const seen = new Set<string>();
    for (const r of REGIONS) {
      expect(typeof r.slug).toBe('string');
      expect(r.slug.length).toBeGreaterThan(0);
      expect(typeof r.name).toBe('string');
      expect(r.name.length).toBeGreaterThan(0);
      expect(seen.has(r.slug)).toBe(false);
      seen.add(r.slug);
    }
  });

  it('is frozen, so a careless edit cannot mutate the bundle', () => {
    expect(Object.isFrozen(REGIONS)).toBe(true);
  });
});

describe('canonicalRegion', () => {
  it('folds every spelling of one scene onto one slug', () => {
    for (const raw of ['bay', 'the-bay', 'sf-bay-area', 'The Bay', ' SF Bay ', 'bayarea']) {
      expect(canonicalRegion(raw)).toBe('bay-area');
    }
  });

  it('folds the spec examples exactly', () => {
    expect(canonicalRegion('so-cal')).toBe('socal');
    expect(canonicalRegion('pacific-northwest')).toBe('pnw');
    expect(canonicalRegion('new-york-metro')).toBe('tri-state');
  });

  it('folds a diacritic-free spelling of an accented scene', () => {
    expect(canonicalRegion('ile de france')).toBe('ile-de-france');
  });

  it('leaves a region it has never heard of alone', () => {
    expect(canonicalRegion('walla-walla')).toBe('walla-walla');
  });

  it('never touches a system marker, even a region-prefixed one', () => {
    // The prefix is the wire format; canonicalization happens on the bare slug
    // and the prefix is added by the protocol. A prefixed slug is a system
    // marker and must pass through untouched, exactly like the walls layer.
    expect(canonicalRegion('happening')).toBe('happening');
    expect(canonicalRegion('region-bay-area')).toBe('region-bay-area');
    expect(canonicalRegion('type-throwie')).toBe('type-throwie');
  });

  it('still slugifies when nothing matches', () => {
    expect(canonicalRegion('  Walla Walla!! ')).toBe('walla-walla');
  });

  it('returns empty for input that normalizes to nothing', () => {
    expect(canonicalRegion('')).toBe('');
    expect(canonicalRegion('   ')).toBe('');
    expect(canonicalRegion('!!!')).toBe('');
  });
});

describe('searchRegions', () => {
  it('finds a region by the start of its name', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'bay ar')[0]?.slug).toBe('bay-area');
  });

  it('finds a region by its slug', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'bay-area')[0]?.slug).toBe('bay-area');
  });

  it('finds a region by a nickname, so typing the-bay offers Bay Area', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'the-bay')[0]?.slug).toBe('bay-area');
    expect(searchRegions(REGIONS_FIXTURE, 'so-cal')[0]?.slug).toBe('socal');
    expect(searchRegions(REGIONS_FIXTURE, 'pacific-northwest')[0]?.slug).toBe('pnw');
    expect(searchRegions(REGIONS_FIXTURE, 'new-york-metro')[0]?.slug).toBe('tri-state');
  });

  it('matches through diacritics both ways', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'sao paulo')[0]?.slug).toBe('greater-sao-paulo');
    expect(searchRegions(REGIONS_FIXTURE, 'são paulo')[0]?.slug).toBe('greater-sao-paulo');
  });

  it('ranks an exact name above a prefix match', () => {
    // "scandinavia" IS a region name; "scandinavian-region" is one of its
    // aliases. The exact name must win.
    expect(searchRegions(REGIONS_FIXTURE, 'scandinavia')[0]?.slug).toBe('scandinavia');
  });

  it('matches a word inside the name, not just the first one', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'california').map((r) => r.slug)).toContain('socal');
  });

  it('ignores case, punctuation and surrounding space', () => {
    expect(searchRegions(REGIONS_FIXTURE, '  BAY AREA!  ')[0]?.slug).toBe('bay-area');
  });

  it('returns nothing for an empty query rather than the whole world', () => {
    expect(searchRegions(REGIONS_FIXTURE, '')).toEqual([]);
    expect(searchRegions(REGIONS_FIXTURE, '   ')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'zzzzzz')).toEqual([]);
  });

  it('caps how many it offers', () => {
    expect(searchRegions(REGIONS_FIXTURE, 'a', 3).length).toBeLessThanOrEqual(3);
  });

  it('never offers the same region twice, however many ways it matched', () => {
    const hits = searchRegions(REGIONS_FIXTURE, 'a');
    expect(new Set(hits.map((r) => r.slug)).size).toBe(hits.length);
  });

  it('honours the shipped suggestion limit by default', () => {
    expect(REGION_SUGGESTION_LIMIT).toBeGreaterThan(0);
    expect(searchRegions(REGIONS, 'a').length).toBeLessThanOrEqual(REGION_SUGGESTION_LIMIT);
  });
});

describe('regionLabel', () => {
  it('says the scene the way a writer would', () => {
    expect(regionLabel(region('bay-area', 'Bay Area'))).toBe('Bay Area');
  });
});

describe('findRegion', () => {
  it('finds a region by its canonical slug', () => {
    expect(findRegion(REGIONS_FIXTURE, 'bay-area')?.name).toBe('Bay Area');
  });

  it('canonicalizes first, so an alias finds the real region', () => {
    expect(findRegion(REGIONS_FIXTURE, 'the-bay')?.slug).toBe('bay-area');
    expect(findRegion(REGIONS_FIXTURE, 'SF Bay')?.slug).toBe('bay-area');
  });

  it('returns null for a region the dataset does not carry', () => {
    expect(findRegion(REGIONS_FIXTURE, 'walla-walla')).toBeNull();
    expect(findRegion(REGIONS_FIXTURE, '')).toBeNull();
  });
});

describe('expandRegion', () => {
  it('lists the canonical slug first, then every alias that folds onto it', () => {
    const out = expandRegion('bay-area');
    expect(out[0]).toBe('bay-area');
    expect(out).toContain('the-bay');
    expect(out).toContain('bay');
    expect(out).toContain('sf-bay-area');
  });

  it('folds the input first, so an alias resolves to its canonical set', () => {
    expect(expandRegion('the-bay')[0]).toBe('bay-area');
  });

  it('is deduped', () => {
    const out = expandRegion('bay-area');
    expect(new Set(out).size).toBe(out.length);
  });

  it('returns just the slug for a region nobody aliases', () => {
    expect(expandRegion('walla-walla')).toEqual(['walla-walla']);
  });

  it('returns nothing for empty input', () => {
    expect(expandRegion('')).toEqual([]);
  });
});
