import { canonicalizeBoard } from '@1nky/protocol';

import aliasFile from './gazetteer/aliases.json';

/**
 * The wall gazetteer — a curated list of cities, shipped from our own origin.
 *
 * Board slugs were free text, so one city minted as many walls as it had
 * nicknames: `sf`, `sf-bay`, `san-francisco` and `frisco` were four feeds. This
 * module is the read side of the fix — a typeahead over ~2.5k cities plus an
 * alias map that folds the nicknames onto one canonical slug.
 *
 * There is no geocoding API here and there never will be one. A typeahead that
 * calls a third party tells that third party which city a writer was about to
 * name, as they type, keyed to their address. So the dataset is a static file we
 * serve ourselves and the search is a substring match over an array in memory.
 *
 * The dataset carries names, regions, country codes and a prominence rank —
 * no coordinates. This project tags cities, never spots. See
 * `src/lib/gazetteer/README.txt` for the source and its licence.
 */

/** One city writers can put a flick on. */
export interface Wall {
  /** Canonical board slug — what actually goes on the post. */
  slug: string;
  /** How the city writes its own name ("Köln", "São Paulo"). */
  name: string;
  /** State / province / county, or '' where the country has no divisions. */
  region: string;
  /** ISO country code. */
  country: string;
  /** 0 is the largest city in the set. Only used to order the menu. */
  rank: number;
}

/**
 * Nickname -> canonical slug, bundled rather than fetched.
 *
 * `/b/sf` has to redirect to `/b/san-francisco` on the first paint, and a post
 * has to canonicalize even if the big dataset never loaded — so this small map
 * rides in the bundle while the ~2.5k-city list is fetched on demand. Keys
 * starting `_` are documentation inside the JSON file, not aliases.
 */
export const WALL_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(aliasFile as Record<string, string>).filter(
      ([key, value]) => !key.startsWith('_') && typeof value === 'string',
    ),
  ),
);

/**
 * The canonical slug for whatever a writer typed.
 *
 * The one function every write path and every board URL goes through. It
 * canonicalizes; it never restricts — a city too small for any dataset still
 * gets its wall, it just gets it under the slug the writer chose.
 */
export function canonicalWall(input: string): string {
  return canonicalizeBoard(input, WALL_ALIASES);
}

/** Where the generated dataset is served from. Our origin, always. */
const DATASET_URL = '/cities.json';

let cache: Wall[] | null = null;
let inFlight: Promise<Wall[]> | null = null;

/** Drop the cached dataset. Tests only. */
export function resetWallsCache(): void {
  cache = null;
  inFlight = null;
}

function parse(payload: unknown): Wall[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const body = payload as { cities?: unknown; regions?: unknown };
  if (!Array.isArray(body.cities)) return [];
  const regions = Array.isArray(body.regions) ? (body.regions as unknown[]) : [];

  const walls: Wall[] = [];
  for (const row of body.cities) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
    const regionIndex = typeof row[2] === 'number' ? row[2] : -1;
    const region = regions[regionIndex];
    walls.push({
      slug: row[0],
      name: row[1],
      region: typeof region === 'string' ? region : '',
      country: typeof row[3] === 'string' ? row[3] : '',
      rank: typeof row[4] === 'number' ? row[4] : Number.MAX_SAFE_INTEGER,
    });
  }
  return walls;
}

/**
 * The city list, fetched once.
 *
 * Failure is not an error state anybody should see: if the file cannot be
 * reached the picker simply has nothing to suggest and the writer types the
 * wall themselves, which has always worked. The empty result is deliberately
 * NOT cached, so the next writer to open the picker tries again.
 */
export async function loadWalls(): Promise<Wall[]> {
  if (cache) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(DATASET_URL);
      if (!response.ok) return [];
      const walls = parse(await response.json());
      if (walls.length) cache = walls;
      return walls;
    } catch {
      return [];
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
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
 * Aliases grouped by target, so a wall can be found by any of its nicknames
 * without scanning the whole alias map per wall per keystroke.
 */
const ALIASES_BY_TARGET: ReadonlyMap<string, string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const alias of Object.keys(WALL_ALIASES)) {
    // Resolved through the chain rather than read straight off the map, so
    // `ny -> nyc -> new-york-city` files `ny` under the wall it actually
    // reaches instead of under the intermediate `nyc`.
    const canonical = canonicalWall(alias);
    const list = out.get(canonical);
    if (list) list.push(fold(alias));
    else out.set(canonical, [fold(alias)]);
  }
  return out;
})();

/** Match tiers, best first. Bigger is better; 0 means no match at all. */
const EXACT = 5;
const ALIAS = 4;
const STARTS = 3;
const WORD = 2;
const PLACE = 1;

function score(wall: Wall, query: string): number {
  const name = fold(wall.name);
  const slug = fold(wall.slug);
  if (name === query || slug === query) return EXACT;

  for (const alias of ALIASES_BY_TARGET.get(wall.slug) ?? []) {
    if (alias === query) return ALIAS;
  }

  if (name.startsWith(query) || slug.startsWith(query)) return STARTS;
  // A word inside the name: "york" should find New York City.
  if (name.split(' ').some((word) => word.startsWith(query))) return WORD;

  const region = fold(wall.region);
  if (region.startsWith(query) || region.split(' ').some((word) => word.startsWith(query))) {
    return PLACE;
  }
  if (fold(wall.country) === query) return PLACE;

  for (const alias of ALIASES_BY_TARGET.get(wall.slug) ?? []) {
    if (alias.startsWith(query)) return PLACE;
  }
  return 0;
}

/** How many suggestions the picker offers at once. */
export const WALL_SUGGESTION_LIMIT = 8;

/**
 * The walls worth offering for what the writer has typed so far.
 *
 * Ranked by how well the text matched, then by how big the city is, which is
 * the only thing that reliably puts London, England above London, Ontario. An
 * empty query offers nothing — a menu of 2,468 cities is not a suggestion.
 */
export function searchWalls(
  walls: readonly Wall[],
  query: string,
  limit: number = WALL_SUGGESTION_LIMIT,
): Wall[] {
  const needle = fold(query);
  if (!needle) return [];

  const hits: { wall: Wall; tier: number }[] = [];
  for (const wall of walls) {
    const tier = score(wall, needle);
    if (tier > 0) hits.push({ wall, tier });
  }
  hits.sort((a, b) => b.tier - a.tier || a.wall.rank - b.wall.rank);
  return hits.slice(0, limit).map((hit) => hit.wall);
}

/** "San Francisco, California" — a place, said the way a person would say it. */
export function wallLabel(wall: Wall): string {
  return wall.region ? `${wall.name}, ${wall.region}` : `${wall.name}, ${wall.country}`;
}

/** The wall a slug (or one of its nicknames) names, or null if we do not carry it. */
export function findWall(walls: readonly Wall[], slug: string): Wall | null {
  const canonical = canonicalWall(slug);
  if (!canonical) return null;
  return walls.find((wall) => wall.slug === canonical) ?? null;
}
