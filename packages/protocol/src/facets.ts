import { HAPPENING_BOARD, normalizeBoard } from './builders.js';
import type { BoardTag } from './types.js';

/**
 * Explore facets — the fixed vocabularies behind the `type-*`, `surface-*`,
 * `region-*` and `legal-*` `t` tags on flicks and videos.
 *
 * `normalizeBoard()` strips every character outside `[a-z0-9-]`, so facets are
 * dash-namespaced (`type-throwie`), never colon-namespaced (`type:throwie` —
 * that would collapse to `typethrowie`). City tags stay unprefixed so the
 * existing `boards` rows keep working untouched. See
 * `docs/design/explore-and-crews.md` Part 3.
 */

/** Fixed graffiti-type vocabulary (Part 1 table). Not freeform. */
export const GRAF_TYPES = [
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
] as const;

export type GrafType = (typeof GRAF_TYPES)[number];

/** Fixed surface vocabulary. */
export const SURFACES = [
  'street',
  'freight',
  'passenger',
  'rooftop',
  'tunnel',
  'highway',
] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * The one-directional legal facet.
 *
 * A signed, permanent "this was illegal" tag would be a non-repudiable
 * confession in the one store this project promises has nothing to
 * subpoena — so only the positive case exists. Absence of this tag IS the
 * negative case; there is no `legal-bombing`. (Design Part 3.2.)
 */
export const LEGAL_PERMISSION_TAG = 'legal-permission';

const TYPE_PREFIX = 'type-';
const SURFACE_PREFIX = 'surface-';
const REGION_PREFIX = 'region-';

/**
 * Every dash-namespace that makes a `t` tag a facet rather than a place.
 *
 * Exported so `canonicalizeBoard` can refuse to fold a facet slug into a city
 * without keeping its own copy of the list — one place to add a namespace.
 */
export const FACET_PREFIXES = [TYPE_PREFIX, SURFACE_PREFIX, REGION_PREFIX] as const;

/**
 * Unprefixed `t` slugs that are system markers rather than cities.
 *
 * The dash-prefix convention covers `type-*`, `surface-*` and `region-*`, but
 * two slugs are deliberately bare — `legal-permission` (a one-directional flag,
 * Part 3.2) and `happening` (a thread marker that rides the board machinery) —
 * and "any unprefixed tag is a city" would read both of them as a place. Every
 * future bare marker belongs in this set, or somebody's Explore page grows a
 * city called `happening`.
 */
export const SYSTEM_SLUGS: ReadonlySet<string> = new Set<string>([
  LEGAL_PERMISSION_TAG,
  HAPPENING_BOARD,
]);

/** `["t", "type-<slug>"]`. */
export function typeTag(t: GrafType): BoardTag {
  return ['t', TYPE_PREFIX + normalizeBoard(t)];
}

/** `["t", "surface-<slug>"]`. */
export function surfaceTag(s: Surface): BoardTag {
  return ['t', SURFACE_PREFIX + normalizeBoard(s)];
}

/** `["t", "region-<slug>"]`. */
export function regionTag(r: string): BoardTag {
  return ['t', REGION_PREFIX + normalizeBoard(r)];
}

/** `["t", "legal-permission"]`. */
export function legalPermissionTag(): BoardTag {
  return ['t', LEGAL_PERMISSION_TAG];
}

export interface ParsedFacets {
  /** The first unprefixed city board tag, or null. */
  city: string | null;
  /** The first `region-*` tag (bare slug, prefix stripped), or null. */
  region: string | null;
  /** Every `type-*` tag whose value is in the fixed vocabulary. */
  types: GrafType[];
  /** Every `surface-*` tag whose value is in the fixed vocabulary. */
  surfaces: Surface[];
  /** True when a `legal-permission` tag is present. */
  legalPermission: boolean;
}

const GRAF_TYPE_SET: ReadonlySet<string> = new Set(GRAF_TYPES);
const SURFACE_SET: ReadonlySet<string> = new Set(SURFACES);

/**
 * Interpret an event's `t` tags back into the five Explore facets.
 *
 * City stays the existing unprefixed board tag. Only vocabulary members are
 * returned for `types` / `surfaces`, so an unknown `type-foo` is ignored
 * rather than surfacing as a junk chip. Repeated values within a facet
 * collapse (the wire form is a set of `t` tags, not a count).
 */
export function parseFacets(tags: readonly string[][]): ParsedFacets {
  let city: string | null = null;
  let region: string | null = null;
  let legalPermission = false;
  const types: GrafType[] = [];
  const surfaces: Surface[] = [];

  for (const tag of tags) {
    if (tag[0] !== 't') continue;
    const slug = normalizeBoard(tag[1] ?? '');
    if (!slug) continue;

    if (slug.startsWith(TYPE_PREFIX)) {
      const value = slug.slice(TYPE_PREFIX.length);
      if (GRAF_TYPE_SET.has(value) && !(types as string[]).includes(value)) {
        types.push(value as GrafType);
      }
      continue;
    }
    if (slug.startsWith(SURFACE_PREFIX)) {
      const value = slug.slice(SURFACE_PREFIX.length);
      if (SURFACE_SET.has(value) && !(surfaces as string[]).includes(value)) {
        surfaces.push(value as Surface);
      }
      continue;
    }
    if (slug.startsWith(REGION_PREFIX)) {
      if (region === null) region = slug.slice(REGION_PREFIX.length);
      continue;
    }
    if (slug === LEGAL_PERMISSION_TAG) {
      legalPermission = true;
      continue;
    }
    // A bare system marker (`happening`) is not a place.
    if (SYSTEM_SLUGS.has(slug)) continue;
    // Unprefixed => city board.
    if (city === null) city = slug;
  }

  return { city, region, types, surfaces, legalPermission };
}
