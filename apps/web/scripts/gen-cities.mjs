/**
 * Builds `public/cities.json` — the curated wall gazetteer behind the "Where"
 * picker.
 *
 *   node scripts/gen-cities.mjs          # uses ~/.cache or ./.geonames cache
 *   node scripts/gen-cities.mjs --fresh  # re-download the source dumps
 *
 * Run OFFLINE by a developer and the result committed. Nothing here runs at
 * request time and the app never fetches anything but its own origin — the
 * whole point of shipping a dataset instead of calling a geocoding API is that
 * no third party ever learns which city a writer typed.
 *
 * ---------------------------------------------------------------------------
 * SOURCE + LICENCE
 *
 * GeoNames geographical database <https://www.geonames.org/>, files
 * `cities15000.txt`, `admin1CodesASCII.txt` and `countryInfo.txt`, licensed
 * under Creative Commons Attribution 4.0 <https://creativecommons.org/licenses/by/4.0/>.
 * Attribution is required and is satisfied by the `_attribution` field written
 * into `public/cities.json` (so it travels with the data) plus this header. It
 * is deliberately NOT surfaced in the UI — the app shows city names, not
 * dataset credits.
 *
 * The derived file keeps only: slug, display name, admin-1 name, country code.
 * No coordinates. A gazetteer with lat/long in it would be a map, and a map is
 * a spot — this project tags cities and never places.
 * ---------------------------------------------------------------------------
 *
 * SELECTION
 *
 *   - population >= 250,000  (~2.4k rows: every city big enough to have a scene)
 *   - plus every entry named in `src/lib/gazetteer/scene-cities.json`, a
 *     hand-kept list of smaller cities with real graffiti history
 *   - feature class P only, and never PPLX (a "section of a city"), because
 *     boroughs and neighbourhoods are spots, not walls
 *
 * SLUGS are the ASCII name, slugified with the same `[a-z0-9-]` rule the wire
 * format uses. When two cities want one slug the larger population keeps it and
 * the loser is suffixed with its country (`london-ca`), then its admin-1 code
 * (`taizhou-js`), then its GeoNames id. Deterministic, so re-running produces
 * byte-identical output and no writer's wall ever silently moves.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const CACHE = join(WEB, '.geonames');
const OUT = join(WEB, 'public', 'cities.json');
const ALIASES = join(WEB, 'src', 'lib', 'gazetteer', 'aliases.json');
const SCENE = join(WEB, 'src', 'lib', 'gazetteer', 'scene-cities.json');

const BASE = 'https://download.geonames.org/export/dump/';
const FILES = ['cities15000.zip', 'admin1CodesASCII.txt', 'countryInfo.txt'];

/** Cities at or above this many people are in by default. */
const POPULATION_FLOOR = 250_000;

/** A "section of a populated place" — a borough. Never a wall of its own. */
const EXCLUDED_FEATURE_CODES = new Set(['PPLX']);

// --- source files -----------------------------------------------------------

async function ensureSources({ fresh }) {
  mkdirSync(CACHE, { recursive: true });
  for (const file of FILES) {
    const path = join(CACHE, file);
    if (!fresh && existsSync(path)) continue;
    process.stdout.write(`fetching ${file}... `);
    const response = await fetch(BASE + file);
    if (!response.ok) throw new Error(`${BASE}${file} -> HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    console.log('ok');
  }
  const txt = join(CACHE, 'cities15000.txt');
  if (fresh || !existsSync(txt)) {
    // `unzip` on POSIX, `tar` (ships with Windows 10+) otherwise.
    try {
      execFileSync('unzip', ['-o', 'cities15000.zip'], { cwd: CACHE, stdio: 'ignore' });
    } catch {
      execFileSync('tar', ['-xf', 'cities15000.zip'], { cwd: CACHE, stdio: 'ignore' });
    }
  }
  if (!existsSync(txt)) throw new Error('could not extract cities15000.txt');
}

const tsv = (path) =>
  readFileSync(join(CACHE, path), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'));

// --- slugs ------------------------------------------------------------------

/**
 * Same output as the protocol's `normalizeBoard`, plus a diacritic fold and the
 * abbreviation expansions that make a slug guessable: nobody types `st-louis`
 * when they mean Saint Louis, and `Ho Chi Minh City` must not become
 * `ho-chi-minh-city` in the data but `hochiminhcity` in a writer's head.
 */
function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[Øø]/g, 'o')
    .replace(/[Ðð]/g, 'd')
    .replace(/[Þþ]/g, 'th')
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .replace(/ß/g, 'ss')
    .replace(/[Łł]/g, 'l')
    .toLowerCase()
    .replace(/\bst\.\s+/g, 'saint ')
    .replace(/\bste\.\s+/g, 'sainte ')
    .replace(/\bmt\.\s+/g, 'mount ')
    .replace(/\bft\.\s+/g, 'fort ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- build ------------------------------------------------------------------

const fresh = process.argv.includes('--fresh');
await ensureSources({ fresh });

const admin1 = new Map(tsv('admin1CodesASCII.txt').map((r) => [r[0], r[2] || r[1]]));
const countries = new Map(tsv('countryInfo.txt').map((r) => [r[0], r[4]]));

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
/** `"Name|CC"` keys, so the hand list reads as places rather than as ids. */
const wanted = new Set(scene.cities.map((entry) => entry.trim()));
const matchedScene = new Set();

const rows = tsv('cities15000.txt');
const picked = [];
for (const r of rows) {
  const [, name, ascii, , , , featureClass, featureCode, cc, , a1] = r;
  const population = Number(r[14]) || 0;
  if (featureClass !== 'P') continue;
  if (EXCLUDED_FEATURE_CODES.has(featureCode)) continue;

  const key = `${name}|${cc}`;
  const isScene = wanted.has(key);
  if (isScene) matchedScene.add(key);
  if (population < POPULATION_FLOOR && !isScene) continue;

  // Slug from the display `name`, NOT GeoNames' `asciiname`: the latter uses
  // German-style transliteration, so Zürich arrives as "Zuerich" and Köln as
  // "Koeln" — slugs nobody would ever type. Our own diacritic fold gives
  // `zurich` / `koln`, and the English spellings ride in aliases.json.
  // `asciiname` is the fallback for names in a script the fold cannot reduce.
  picked.push({
    id: Number(r[0]),
    name,
    slug: slugify(name) || slugify(ascii),
    region: admin1.get(`${cc}.${a1}`) ?? '',
    cc,
    population,
    a1,
  });
}

// Every hand-listed scene city must actually resolve, or the list rots quietly.
const missingScene = [...wanted].filter((key) => !matchedScene.has(key));
if (missingScene.length) {
  console.error('\nscene-cities.json names entries GeoNames does not have:');
  for (const key of missingScene) console.error('  ' + key);
  process.exitCode = 1;
}

// A scene entry that has grown past the floor is now carried by the population
// rule and can be deleted — reported, not fatal, so the list stays honest about
// being "the ones too small to qualify".
const redundantScene = picked
  .filter((c) => c.population >= POPULATION_FLOOR && wanted.has(`${c.name}|${c.cc}`))
  .map((c) => `${c.name}|${c.cc} (pop ${c.population})`);
if (redundantScene.length) {
  console.warn(`\nscene-cities.json: ${redundantScene.length} entries are above the floor anyway:`);
  for (const line of redundantScene.sort()) console.warn('  ' + line);
}

// Biggest city keeps the bare slug; losers get a deterministic suffix.
picked.sort((a, b) => b.population - a.population || a.id - b.id);
const taken = new Map();
for (const city of picked) {
  for (const candidate of [
    city.slug,
    `${city.slug}-${city.cc.toLowerCase()}`,
    `${city.slug}-${(city.a1 || '').toLowerCase()}`,
    `${city.slug}-${city.id}`,
  ]) {
    if (candidate && !taken.has(candidate)) {
      city.slug = candidate;
      taken.set(candidate, city);
      break;
    }
  }
}

// Prominence rank, captured while the list is still population-ordered: the
// typeahead needs SOME way to put London above London, Ontario for "lon", and
// this is the whole of the population signal we keep. Coordinates and raw
// populations are dropped — a rank is enough to sort a menu and says nothing
// about anybody.
picked.forEach((city, index) => {
  city.rank = index;
});

// Alphabetical on disk: population numbers churn between GeoNames dumps but
// names do not, so ordering by slug keeps the committed diff readable. The
// picker reads `rank`, never the file order.
picked.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

// Region names are repeated hundreds of times ("California", "England"), so
// they are interned and referenced by index. Roughly halves the payload.
const regions = [];
const regionIndex = new Map();
const cities = picked.map((city) => {
  let idx = -1;
  if (city.region) {
    idx = regionIndex.get(city.region) ?? -1;
    if (idx === -1) {
      idx = regions.length;
      regions.push(city.region);
      regionIndex.set(city.region, idx);
    }
  }
  return [city.slug, city.name, idx, city.cc, city.rank];
});

// --- validate the hand-maintained alias overlay against the result ----------

const aliasFile = JSON.parse(readFileSync(ALIASES, 'utf8'));
const aliases = Object.fromEntries(
  Object.entries(aliasFile).filter(([key]) => !key.startsWith('_')),
);
const slugs = new Set(cities.map((c) => c[0]));
const broken = [];
for (const [alias, target] of Object.entries(aliases)) {
  if (slugs.has(alias)) broken.push(`${alias} -> ${target} (alias IS a real slug)`);
  // A target may be another alias (one hop is resolved by canonicalizeBoard).
  if (!slugs.has(target) && !(target in aliases)) broken.push(`${alias} -> ${target} (no such wall)`);
}
if (broken.length) {
  console.error(`\naliases.json has ${broken.length} broken entr${broken.length === 1 ? 'y' : 'ies'}:`);
  for (const line of broken) console.error('  ' + line);
  process.exitCode = 1;
}

// --- write ------------------------------------------------------------------

const payload = {
  _attribution:
    'City names, regions and countries derived from the GeoNames geographical database (https://www.geonames.org/), licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Trimmed and re-slugged by apps/web/scripts/gen-cities.mjs; no coordinates retained.',
  version: 1,
  // ["slug", "Display Name", regionIndex, "CC", rank] — regionIndex is -1 when
  // the country has no admin-1 division; rank is 0 for the largest city.
  fields: ['slug', 'name', 'region', 'country', 'rank'],
  regions,
  countries: Object.fromEntries(
    [...new Set(cities.map((c) => c[3]))].sort().map((cc) => [cc, countries.get(cc) ?? cc]),
  ),
  cities,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload) + '\n');

const bytes = Buffer.byteLength(JSON.stringify(payload));
const gz = (await import('node:zlib')).gzipSync(JSON.stringify(payload), { level: 9 }).length;
console.log(
  `\ncities.json: ${cities.length} walls, ${regions.length} regions, ` +
    `${Object.keys(aliases).length} aliases · ${(bytes / 1024).toFixed(0)}KB raw, ${(gz / 1024).toFixed(0)}KB gzipped`,
);
if (process.exitCode) console.error('\nWROTE THE FILE, BUT THE CHECKS ABOVE FAILED — fix them.');
