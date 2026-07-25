import { GRAF_TYPES, SURFACES } from '@1nky/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { useTag } from '../state/TagProvider.js';
import {
  fetchExplore,
  fetchExploreFacets,
  type ExploreFilter,
  type FacetOption,
} from '../lib/explore.js';
import type { Flick } from '../lib/feed.js';

// The fixed vocabularies drive the chip rows even when the API has no counts
// yet (a fresh box, or the facets endpoint unreachable): the writer can still
// pick a type/surface to filter on. Counts from the API annotate the chips
// when available.
const TYPE_OPTIONS = GRAF_TYPES;
const SURFACE_OPTIONS = SURFACES;

/** `/explore` — browse the wall by where it is and by what it is, combined. */
export function Explore(): JSX.Element {
  const { tag } = useTag();
  const [cities, setCities] = useState<FacetOption[]>([]);
  const [regions, setRegions] = useState<FacetOption[]>([]);
  const [typeSet, setTypeSet] = useState<Set<string>>(new Set());
  const [surfaceSet, setSurfaceSet] = useState<Set<string>>(new Set());
  const [city, setCity] = useState<string[]>([]);
  const [region, setRegion] = useState<string>('');
  const [legal, setLegal] = useState(false);
  const [facetsLoaded, setFacetsLoaded] = useState(false);

  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  // Load the chip counts once.
  useEffect(() => {
    let live = true;
    void fetchExploreFacets().then((facets) => {
      if (!live) return;
      setCities(facets.cities);
      setRegions(facets.regions);
      setFacetsLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const filter: ExploreFilter = {
    ...(city.length ? { city } : {}),
    ...(typeSet.size ? { type: [...typeSet] } : {}),
    ...(surfaceSet.size ? { surface: [...surfaceSet] } : {}),
    ...(region ? { region: [region] } : {}),
    ...(legal ? { legal: true } : {}),
  };

  const loadMore = useCallback(
    async (from: string | null, replace: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const page = await fetchExplore(filter, from);
        setFailed(false);
        setDegraded(page.degraded);
        setFlicks((current) => {
          const merged = replace ? page.flicks : [...current, ...page.flicks];
          const seen = new Set<string>();
          return merged.filter((f) => !seen.has(f.id) && seen.add(f.id));
        });
        setCursor(page.cursor);
        if (!page.cursor || page.flicks.length === 0) setExhausted(true);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
        busy.current = false;
      }
    },
    // filter is recomputed every render; depend on its string form to avoid
    // re-running on every keystroke into the city box etc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(filter)],
  );

  // Restart the wall whenever the active filter changes.
  useEffect(() => {
    setFlicks([]);
    setCursor(null);
    setExhausted(false);
    void loadMore(null, true);
  }, [loadMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || exhausted || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore(cursor, false);
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, exhausted, loadMore]);

  const toggle = (set: Set<string>, value: string, update: (next: Set<string>) => void): void => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const activeFilterPills: { label: string; clear: () => void }[] = [];
  for (const c of city) activeFilterPills.push({ label: c, clear: () => setCity((prev) => prev.filter((x) => x !== c)) });
  for (const t of typeSet) activeFilterPills.push({ label: `type-${t}`, clear: () => toggle(typeSet, t, setTypeSet) });
  for (const s of surfaceSet) activeFilterPills.push({ label: `surface-${s}`, clear: () => toggle(surfaceSet, s, setSurfaceSet) });
  if (region) activeFilterPills.push({ label: `region-${region}`, clear: () => setRegion('') });
  if (legal) activeFilterPills.push({ label: 'had permission', clear: () => setLegal(false) });

  const hasFilter = activeFilterPills.length > 0;
  const clearAll = (): void => {
    setCity([]);
    setTypeSet(new Set());
    setSurfaceSet(new Set());
    setRegion('');
    setLegal(false);
  };

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <span className="tape">browse</span>
        <h2 style={{ marginTop: 12 }}>Explore</h2>
      </div>

      <section className="facets">
        <div className="facet-group">
          <span className="facet-group__label">Where</span>
          <div className="chips">
            <button
              type="button"
              className={`chip ${city.length === 0 ? 'chip--active' : ''}`}
              onClick={() => setCity([])}
            >
              all cities
            </button>
            {cities.map((c) => (
              <button
                key={c.slug}
                type="button"
                className={`chip ${city.includes(c.slug) ? 'chip--active' : ''}`}
                onClick={() =>
                  setCity((prev) => (prev.includes(c.slug) ? prev.filter((x) => x !== c.slug) : [...prev, c.slug]))
                }
              >
                {c.slug}
                <span className="chip__count">{c.count}</span>
              </button>
            ))}
            {!facetsLoaded && cities.length === 0 ? (
              <span className="muted" style={{ fontSize: '0.85rem' }}>no city counts yet — post a flick with a where to seed them</span>
            ) : null}
          </div>
        </div>

        <div className="facet-group">
          <span className="facet-group__label">What</span>
          <div className="chips">
            {TYPE_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${typeSet.has(t) ? 'chip--active' : ''}`}
                onClick={() => toggle(typeSet, t, setTypeSet)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="facet-group">
          <span className="facet-group__label">Surface</span>
          <div className="chips">
            {SURFACE_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip ${surfaceSet.has(s) ? 'chip--active' : ''}`}
                onClick={() => toggle(surfaceSet, s, setSurfaceSet)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {regions.length > 0 ? (
          <div className="facet-group">
            <span className="facet-group__label">Region</span>
            <div className="chips">
              <button
                type="button"
                className={`chip ${region === '' ? 'chip--active' : ''}`}
                onClick={() => setRegion('')}
              >
                all
              </button>
              {regions.map((r) => (
                <button
                  key={r.slug}
                  type="button"
                  className={`chip ${region === r.slug ? 'chip--active' : ''}`}
                  onClick={() => setRegion(r.slug)}
                >
                  {r.slug}
                  <span className="chip__count">{r.count}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <label className={`toggle ${legal ? 'toggle--on' : ''}`}>
          <span className="toggle__box" aria-hidden="true" />
          <input
            type="checkbox"
            className="sr-only"
            checked={legal}
            onChange={(e) => setLegal(e.target.checked)}
          />
          had permission
        </label>
      </section>

      {hasFilter ? (
        <div className="chips" style={{ gap: 8 }}>
          {activeFilterPills.map((pill, i) => (
            <span key={i} className="filter-pill">
              {pill.label}
              <button type="button" aria-label={`Clear ${pill.label}`} onClick={pill.clear}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="kicker" style={{ textDecoration: 'underline' }} onClick={clearAll}>
            clear all
          </button>
        </div>
      ) : null}

      <hr className="rule" />

      {flicks.length === 0 && !loading ? (
        <div className="empty">
          <h2>{hasFilter ? 'Nothing matches that.' : 'Wall is empty.'}</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            {hasFilter
              ? 'Loosen it up, or put the first one up yourself.'
              : 'Be the first to put something up.'}
          </p>
          {tag ? (
            <Link to="/post" className="btn btn--go sticker">
              Put something up
            </Link>
          ) : null}
          {failed ? <p className="help" style={{ marginTop: 20 }}>Could not reach the wall.</p> : null}
        </div>
      ) : (
        <div className="wall">
          {flicks.map((flick) => (
            <FlickCard key={flick.id} flick={flick} />
          ))}
        </div>
      )}

      {degraded ? <p className="help" style={{ textAlign: 'center' }}>Showing what the wall has — the full counts are not reachable right now.</p> : null}

      <div ref={sentinel} style={{ height: 1 }} />
      {loading ? <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>loading</p> : null}
      {exhausted && flicks.length > 0 ? (
        <p className="faint mono" style={{ textAlign: 'center', padding: '24px 0 40px' }}>
          that&apos;s the whole wall
        </p>
      ) : null}
    </div>
  );
}