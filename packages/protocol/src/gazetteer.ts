import { normalizeBoard } from './builders.js';
import { FACET_PREFIXES, SYSTEM_SLUGS } from './facets.js';

/**
 * Board canonicalization — the rule that keeps one city from minting four walls.
 *
 * `normalizeBoard()` is the wire format and is deliberately dumb: it slugifies
 * whatever it is given, which is why `sf`, `sf-bay`, `san-francisco` and
 * `frisco` all pass through it happily as four different walls. This module
 * sits ABOVE it and folds known spellings of the same place onto one slug.
 *
 * The alias DATA lives in the web app (`apps/web/src/lib/gazetteer/`) — it is a
 * curated, editable list of place nicknames, not part of the wire protocol.
 * What lives here is only the pure rule for applying it, so every reader (the
 * posting form, the `/b/:slug` redirect, any future indexer backfill) folds
 * slugs the same way. Nothing here is a wire-format change: a signed event
 * already published keeps whatever slug it was signed with, forever.
 */

/**
 * How far an alias chain is followed before it is abandoned.
 *
 * Aliases are meant to point straight at a canonical slug, but a hand-edited
 * map picks up `ny -> nyc -> new-york-city` links naturally, and refusing to
 * follow them would make the map's correctness depend on the order somebody
 * typed it. Four hops is far more than any real map needs; the cap exists so a
 * bad edit is a stale answer rather than a hung tab.
 */
export const MAX_ALIAS_HOPS = 4;

/** An alias map, however the caller happens to be holding it. */
export type AliasMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function lookup(map: AliasMap, key: string): string | null {
  if (map instanceof Map) {
    const value = map.get(key);
    return typeof value === 'string' ? value : null;
  }
  // A map parsed from fetched JSON is a plain object, so `constructor` and
  // `toString` are reachable through the prototype. Own properties only.
  if (!Object.hasOwn(map, key)) return null;
  const value = (map as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Is this slug a system marker rather than a place?
 *
 * Two shapes count: the dash-namespaced facets (`type-*`, `surface-*`,
 * `region-*`) and the bare markers `happening` and `legal-permission`. They are
 * excluded from canonicalization in BOTH directions — a marker is never folded
 * into a city, and no alias may resolve TO one. Without this, one careless line
 * in the alias file could quietly retarget every happening on the site.
 *
 * `holler` is deliberately NOT in here: it is an ordinary board slug that
 * happens to have its own front door, and treating it as a system marker would
 * be a lie the rest of the code would have to keep.
 */
export function isSystemBoard(board: string): boolean {
  const slug = normalizeBoard(board);
  if (!slug) return false;
  if (SYSTEM_SLUGS.has(slug)) return true;
  return FACET_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

/**
 * The canonical slug for a wall the writer named.
 *
 * Normalizes first (so `"SF Bay"` and `sf-bay` fold identically), then follows
 * the alias map. An unknown slug is returned normalized and otherwise
 * untouched — this canonicalizes, it never restricts. That is the whole reason
 * a writer in a town too small for any dataset can still name their own wall.
 *
 * Pure, total, and never throws: it runs on every post and on every board URL.
 */
export function canonicalizeBoard(board: string, aliases?: AliasMap): string {
  let slug = normalizeBoard(board);
  if (!slug || !aliases) return slug;
  // A marker is not a place, so it is never looked up.
  if (isSystemBoard(slug)) return slug;

  const seen = new Set<string>([slug]);
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const raw = lookup(aliases, slug);
    if (raw === null) break;
    const next = normalizeBoard(raw);
    // A target that is empty, a system marker, itself, or somewhere we have
    // already been is a broken entry — keep the best slug reached so far
    // rather than propagating the mistake.
    if (!next || next === slug || seen.has(next) || isSystemBoard(next)) break;
    seen.add(next);
    slug = next;
  }
  return slug;
}
