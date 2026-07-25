import { describe, expect, it } from 'vitest';

import {
  GRAF_TYPES,
  legalPermissionTag,
  LEGAL_PERMISSION_TAG,
  parseFacets,
  regionTag,
  surfaceTag,
  SURFACES,
  typeTag,
} from './facets.js';
import type { Tag } from './types.js';

const tTags = (tags: Tag[]): Tag[] => tags.filter((tag) => tag[0] === 't');

describe('facet vocabularies', () => {
  it('lists the 14 fixed graffiti types', () => {
    expect(GRAF_TYPES).toEqual([
      'tag',
      'handstyle',
      'throwie',
      'straight-letter',
      'piece',
      'wildstyle',
      'burner',
      'roller',
      'blockbuster',
      'sticker',
      'freight',
      'streak',
      'production',
      'character',
    ]);
  });

  it('lists the 6 fixed surfaces', () => {
    expect(SURFACES).toEqual(['street', 'freight', 'passenger', 'rooftop', 'tunnel', 'highway']);
  });

  it('exposes exactly one legal value (the positive case only)', () => {
    expect(LEGAL_PERMISSION_TAG).toBe('legal-permission');
  });
});

describe('facet tag helpers', () => {
  it('typeTag dash-namespaces through normalizeBoard', () => {
    expect(typeTag('throwie')).toEqual(['t', 'type-throwie']);
    expect(typeTag('straight-letter')).toEqual(['t', 'type-straight-letter']);
  });

  it('surfaceTag dash-namespaces', () => {
    expect(surfaceTag('street')).toEqual(['t', 'surface-street']);
    expect(surfaceTag('freight')).toEqual(['t', 'surface-freight']);
  });

  it('regionTag normalises a free label into a region slug', () => {
    expect(regionTag('Bay Area')).toEqual(['t', 'region-bay-area']);
    expect(regionTag('PNW')).toEqual(['t', 'region-pnw']);
  });

  it('legalPermissionTag emits the single legal slug', () => {
    expect(legalPermissionTag()).toEqual(['t', 'legal-permission']);
  });
});

describe('parseFacets', () => {
  it('round-trips facet tags back into the vocabulary', () => {
    const tags: Tag[] = [
      ['t', 'sf-bay'],
      ['t', 'region-bay-area'],
      ['t', 'type-throwie'],
      ['t', 'surface-street'],
      ['t', 'legal-permission'],
      ['imeta', 'url x'],
    ];

    expect(parseFacets(tags)).toEqual({
      city: 'sf-bay',
      region: 'bay-area',
      types: ['throwie'],
      surfaces: ['street'],
      legalPermission: true,
    });
  });

  it('keeps city as the unprefixed board tag and ignores empties', () => {
    expect(parseFacets([['t', ''], ['t', 'nyc'], ['e', 'x']])).toMatchObject({ city: 'nyc' });
  });

  it('drops an unknown type/surface rather than surfacing junk', () => {
    const parsed = parseFacets([
      ['t', 'type-foo'],
      ['t', 'surface-bar'],
    ]);
    expect(parsed.types).toEqual([]);
    expect(parsed.surfaces).toEqual([]);
  });

  it('collects multiple types and surfaces, deduped', () => {
    const parsed = parseFacets([
      ['t', 'type-throwie'],
      ['t', 'type-piece'],
      ['t', 'type-throwie'],
      ['t', 'surface-street'],
      ['t', 'surface-freight'],
    ]);
    expect(parsed.types).toEqual(['throwie', 'piece']);
    expect(parsed.surfaces).toEqual(['street', 'freight']);
  });

  it('reports legalPermission false when the tag is absent', () => {
    expect(parseFacets([['t', 'sf-bay']]).legalPermission).toBe(false);
  });

  it('a round trip through the helpers parses back to the same facets', () => {
    const tags: Tag[] = [
      ['t', 'sf-bay'],
      typeTag('piece'),
      typeTag('wildstyle'),
      surfaceTag('freight'),
      regionTag('SoCal'),
      legalPermissionTag(),
    ];
    expect(parseFacets(tags)).toEqual({
      city: 'sf-bay',
      region: 'socal',
      types: ['piece', 'wildstyle'],
      surfaces: ['freight'],
      legalPermission: true,
    });
    // The helpers produced only t tags.
    expect(tTags(tags)).toHaveLength(6);
  });
});
