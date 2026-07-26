import { canonicalizeBoard } from '@1nky/protocol';

import regionFile from './gazetteer/regions.json';

/**
 * The region gazetteer — a curated list of graffiti scenes, shipped from our
 * own origin.
 *
 * The Region facet used to be free text, so one scene minted as many region
 * tags as it had nicknames: `bay-area`, `the-bay`, `sf-bay-area` and `bay` were
 * four feeds. This module is the read side of the fix — a typeahead over the
 * bundled scenes plus an alias map that folds the nicknames onto one canonical
 * slug. It is the region twin of {@link './walls.ts'}.
 *
 * There is no fetch here and there never will be one. The wall list is ~2.5k
 * cities and is fetched on demand the first time a writer opens the Where
 * picker; the region list is small enough (~90 scenes) to ride in the bundle,
 * so a region typeahead has suggestions on the first keystroke and the
 * canonicalizer works offline. A typeahead that called a third party would
 * hand them the one thing this project promises not to collect — which scene a
 * writer was about to tag, keyed to their address.
 *
 * The canonical rule itself lives in `@1nky/protocol` (`canonicalizeBoard`);
 * only the DATA lives here. Region facets are stored on the wire as
 * `region-<slug>` (the prefix is added by the protocol's `facetBoardTags`), so
 * canonicalization runs on the BARE slug — `bay-area`, not `region-bay-area` —
 * the same way walls canonicalize bare city slugs before they become
 * unprefixed `t` tags. A `region-*` slug is a system marker to
 * `canonicalizeBoard` and is never folded, which is exactly why the bare slug
 * is what we feed it.
 */

/** One graffiti scene writers can file a flick under. */
export interface Region {
  /** Canonical region slug — the bare form that gets the `region-` prefix on the wire. */
  slug: string;
  /** How the scene writes its own name ("Bay Area", "Île-de-France"). */
  name: string;
}

function parseRegions(payload: unknown): Region[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const body = payload as { regions?: unknown };
  if (!Array.isArray(body.regions)) return [];
  const out: Region[] = [];
  for (const row of body.regions) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { slug?: unknown; name?: unknown };
    if (typeof r.slug !== 'string' || typeof r.name !== 'string') continue;
    out.push({ slug: r.slug, name: r.name });
  }
  return out;
}

/**
 * The bundled scenes. Frozen so a careless edit cannot mutate the bundle the
 * next writer sees.
 */
export const REGIONS: readonly Region[] = Object.freeze(parseRegions(regionFile));

/**
 * Nickname -> canonical slug, bundled. The whole point of carrying this in the
 * bundle (rather than fetching it) is that a region has to canonicalize even
 * with the network off — old `region-the-bay` posts and new `region-bay-area`
 * posts have to bucket together on the Explore chips whether the big city list
 * loaded or not. Keys starting `_` are documentation inside the JSON file, not
 * aliases.
 */
export const REGION_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries((regionFile as { aliases?: Record<string, string> }).aliases ?? {}).filter(
      ([key, value]) => !key.startsWith('_') && typeof value === 'string',
    ),
  ),
);

/**
 * The canonical slug for whatever a writer typed.
 *
 * The one function every write path and every region filter goes through. It
 * canonicalizes; it never restricts — a scene too small or too new for the
 * curated list still gets its tag, it just gets it under the slug the writer
 * chose. Mirrors {@link canonicalWall} exactly, with a region-shaped alias map.
 */
export function canonicalRegion(input: string): string {
  return canonicalizeBoard(input, REGION_ALIASES);
}

// --- search -----------------------------------------------------------------

/** Fold a name or a query down to comparable letters. */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Aliases grouped by target, so a region can be found by any of its nicknames
 * without scanning the whole alias map per region per keystroke. Stores the
 * RAW alias slugs (not folded) so {@link expandRegion} can hand them to the API
 * verbatim; {@link searchRegions} folds them on the fly for matching.
 */
const ALIASES_BY_TARGET: ReadonlyMap<string, string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const alias of Object.keys(REGION_ALIASES)) {
    // Resolved through the chain rather than read straight off the map, in step
    // with the wall gazetteer.
    const canonical = canonicalRegion(alias);
    const list = out.get(canonical);
    if (list) list.push(alias);
    else out.set(canonical, [alias]);
  }
  return out;
})();

/** Match tiers, best first. Bigger is better; 0 means no match at all. */
const EXACT = 5;
const ALIAS = 4;
const STARTS = 3;
const WORD = 2;
const ALIAS_START = 1;

function score(region: Region, query: string): number {
  const name = fold(region.name);
  const slug = fold(region.slug);
  if (name === query || slug === query) return EXACT;

  for (const alias of ALIASES_BY_TARGET.get(region.slug) ?? []) {
    if (fold(alias) === query) return ALIAS;
  }

  if (name.startsWith(query) || slug.startsWith(query)) return STARTS;
  // A word inside the name: "california" should find Southern California.
  if (name.split(' ').some((word) => word.startsWith(query))) return WORD;

  for (const alias of ALIASES_BY_TARGET.get(region.slug) ?? []) {
    if (fold(alias).startsWith(query)) return ALIAS_START;
  }
  return 0;
}

/** How many suggestions the picker offers at once. */
export const REGION_SUGGESTION_LIMIT = 8;

/**
 * The scenes worth offering for what the writer has typed so far.
 *
 * Ranked by how well the text matched, then by name for a stable order (walls
 * break ties on city prominence; regions have no prominence, so the alphabet
 * decides). An empty query offers nothing — a menu of every scene is not a
 * suggestion.
 */
export function searchRegions(
  regions: readonly Region[],
  query: string,
  limit: number = REGION_SUGGESTION_LIMIT,
): Region[] {
  const needle = fold(query);
  if (!needle) return [];

  const hits: { region: Region; tier: number }[] = [];
  for (const region of regions) {
    const tier = score(region, needle);
    if (tier > 0) hits.push({ region, tier });
  }
  hits.sort((a, b) => b.tier - a.tier || a.region.name.localeCompare(b.region.name));
  return hits.slice(0, limit).map((hit) => hit.region);
}

/** "Bay Area" — a scene, said the way a writer would say it. */
export function regionLabel(region: Region): string {
  return region.name;
}

/** The region a slug (or one of its nicknames) names, or null if we do not carry it. */
export function findRegion(regions: readonly Region[], slug: string): Region | null {
  const canonical = canonicalRegion(slug);
  if (!canonical) return null;
  return regions.find((region) => region.slug === canonical) ?? null;
}

/**
 * The canonical slug plus every alias that folds onto it.
 *
 * Used to build the Explore region FILTER: old posts carry whatever slug the
 * writer typed (`region-the-bay`, `region-bay`, `region-sf-bay-area`), and a
 * filter that asks for only `region-bay-area` would miss them. Sending the
 * whole alias set lets the API OR them (and the degraded client-side filter
 * match any of them), so old and new bucket together on the wall — without
 * ever rewriting a signed event. The canonical slug is always first.
 */
export function expandRegion(canonical: string): string[] {
  const slug = canonicalRegion(canonical);
  if (!slug) return [];
  const aliases = ALIASES_BY_TARGET.get(slug) ?? [];
  return [...new Set<string>([slug, ...aliases])];
}
