The wall gazetteer
==================

Why this exists
---------------
Board slugs used to be free text. `normalizeBoard()` slugifies whatever it is
handed, so one city minted as many walls as it had nicknames: `sf`, `sf-bay`,
`san-francisco` and `frisco` were four different places with four different
feeds. This directory is the curated list that folds them back into one.

The privacy-shaped part: the obvious fix is a geocoding/maps API, and we will
never have one. A typeahead that calls out to a third party tells that third
party which city a writer was about to tag a flick with, keyed to their IP, as
they type. So the dataset is checked in and served from our own origin, and the
picker is a substring match over an array in memory. Nothing about a visitor
leaves the box. (Also why there are no coordinates in here: this project tags
cities, never spots.)


Files
-----
aliases.json         Hand-maintained. `{"<what people type>": "<canonical slug>"}`.
                     BUNDLED into the app, not fetched, because /b/sf has to
                     redirect to /b/san-francisco with no round trip. Small
                     enough (~400 entries) that this costs nothing.

scene-cities.json    Hand-maintained. Cities below the population floor that
                     belong in the picker anyway (Basel, Ramallah, Berkeley...).
                     GENERATOR INPUT ONLY — never shipped.

../../public/cities.json
                     GENERATED. Do not hand-edit. ~2.5k walls, ~108KB raw /
                     ~43KB gzipped, fetched on demand the first time somebody
                     opens the picker. Deliberately kept out of the service
                     worker precache (see vite.config.ts) so a writer who never
                     names a city never downloads it.

../walls.ts          The loader, the search, and the alias plumbing.
                     `canonicalizeBoard` itself lives in @1nky/protocol.


Regenerating
------------
    cd apps/web
    pnpm cities            # uses the cached dumps in .geonames/
    pnpm cities --fresh    # re-download from GeoNames first

The script validates as it goes and exits non-zero on:
  - a scene-cities.json entry GeoNames no longer has under that exact name
  - an aliases.json entry whose target is not a real wall
  - an aliases.json key that IS a real wall (it would shadow a real city —
    this is how we caught `van` -> vancouver, since Van is a city in Turkey)
It also warns about scene-cities.json entries that have grown past the
population floor and can simply be deleted.

Commit the regenerated public/cities.json together with any alias edits.


Selection rules
---------------
  - population >= 250,000, which is ~2.4k cities worldwide
  - plus everything in scene-cities.json
  - GeoNames feature class P only, and never feature code PPLX ("section of a
    populated place"), because boroughs and neighbourhoods are spots, not walls

Slugs come from the display name with diacritics folded, NOT from GeoNames'
`asciiname` field — that one uses German-style transliteration and would give us
`zuerich` and `koeln`, which nobody types. So the canonical slugs are `zurich`
and `koln`, and `cologne`/`zuerich` are aliases. Where GeoNames prefers a local
spelling (Gent, Sevilla, Århus) that spelling is canonical and the English name
is the alias. When two cities want one slug, the larger keeps it and the smaller
is suffixed with its country, then its admin-1 code, then its GeoNames id:
`london` / `london-ca`, `taizhou` / `taizhou-js`.


SOURCE AND LICENCE
------------------
Derived from the GeoNames geographical database:

    https://www.geonames.org/
    files: cities15000.txt, admin1CodesASCII.txt, countryInfo.txt
    licence: Creative Commons Attribution 4.0 International (CC BY 4.0)
             https://creativecommons.org/licenses/by/4.0/

CC BY requires attribution. It is carried in the `_attribution` field of the
generated public/cities.json, so the credit travels with the data wherever the
file goes, and in the header comment of scripts/gen-cities.mjs. It is
deliberately NOT rendered in the UI: the app shows writers city names, not
dataset credits, and a licence notice in the posting form would be noise.

Only names, admin-1 names, country codes and a prominence rank are retained.
No coordinates, no populations, no GeoNames ids.
