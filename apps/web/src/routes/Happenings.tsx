import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WriterChip } from '../components/WriterChip.js';
import { threadHeadline } from '../lib/boards.js';
import { fetchExploreFacets, type FacetOption } from '../lib/explore.js';
import {
  fetchHappenings,
  groupHappenings,
  HAPPENING_BOARD,
  HAPPENING_CLEARS_COPY,
  whenText,
  type Happening,
} from '../lib/happenings.js';

/**
 * `/happenings` — what is coming up: jams, meets, shows.
 *
 * Ordered by when things go down rather than when they were posted, which is
 * the whole difference between this and a board. The headings do the work a
 * calendar would: "this weekend" and "next week" are how somebody decides
 * whether they are going, and a plain date is how they decide anything further
 * out than that.
 *
 * The city row is the same chip picker Explore uses — same shape, same counts,
 * so "where" means the same thing on both screens.
 */
export function Happenings(): JSX.Element {
  const [cities, setCities] = useState<FacetOption[]>([]);
  const [city, setCity] = useState('');
  const [happenings, setHappenings] = useState<Happening[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchExploreFacets().then((facets) => {
      if (live) setCities(facets.cities);
    });
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(
    async (from: string | null, alive: () => boolean = () => true): Promise<void> => {
      setLoading(true);
      try {
        const page = await fetchHappenings({ ...(city ? { city } : {}), cursor: from });
        if (!alive()) return;
        setHappenings((current) => {
          const merged = from ? [...current, ...page.happenings] : page.happenings;
          const seen = new Set<string>();
          return merged.filter((h) => !seen.has(h.id) && seen.add(h.id));
        });
        setCursor(page.cursor);
        setFailed(false);
      } catch {
        if (alive()) setFailed(true);
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [city],
  );

  useEffect(() => {
    let live = true;
    setHappenings([]);
    setCursor(null);
    void load(null, () => live);
    return () => {
      live = false;
    };
  }, [load]);

  const groups = groupHappenings(happenings);

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <span className="tape">what&apos;s coming</span>
        <h2 style={{ marginTop: 12 }}>Happenings</h2>
        <p className="help" style={{ marginTop: 10 }}>
          Jams, meets and shows somebody put a date on. Each one {HAPPENING_CLEARS_COPY}.
        </p>
      </div>

      <section className="facets">
        <div className="facet-group">
          <span className="facet-group__label">Where</span>
          <div className="chips">
            <button
              type="button"
              className={`chip ${city === '' ? 'chip--active' : ''}`}
              onClick={() => setCity('')}
            >
              everywhere
            </button>
            {cities.map((option) => (
              <button
                key={option.slug}
                type="button"
                className={`chip ${city === option.slug ? 'chip--active' : ''}`}
                onClick={() => setCity((current) => (current === option.slug ? '' : option.slug))}
              >
                {option.slug}
                <span className="chip__count">{option.count}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <hr className="rule" />

      {happenings.length === 0 && !loading ? (
        <div className="empty">
          <h2>{city ? 'Nothing on in ' + city + '.' : 'Nothing on yet.'}</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            Put the first one up — pick the wall it goes up on and flip the switch.
          </p>
          <Link to="/boards" className="btn btn--go sticker">
            Put one on
          </Link>
          {failed ? (
            <p className="help" style={{ marginTop: 20 }}>
              Could not reach the wall.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack stack--wide">
          {groups.map((group) => (
            <section key={group.label} className="stack">
              <h3>{group.label}</h3>
              <ul className="list-reset stack">
                {group.happenings.map((happening) => (
                  <li key={happening.id}>
                    <HappeningRow happening={happening} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {loading ? (
        <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
          loading
        </p>
      ) : null}

      {cursor && !loading ? (
        <button type="button" className="btn btn--ghost btn--block" onClick={() => void load(cursor)}>
          More
        </button>
      ) : null}
    </div>
  );
}

/** One row: what it is, when it goes down, who put it on. */
export function HappeningRow({ happening }: { happening: Happening }): JSX.Element {
  const headline = threadHeadline(happening);
  const showExcerpt = Boolean(happening.subject && happening.excerpt.trim());
  // The marker slug is plumbing, not a place — a writer never needs to see it.
  const where = happening.boards.filter((slug) => slug !== HAPPENING_BOARD);

  return (
    <Link to={`/t/${happening.id}`} className="thread">
      <div className="thread__top">
        <span className="thread__subject">{headline}</span>
        <span className="when-chip mono">{whenText(happening.happeningAt)}</span>
      </div>

      {showExcerpt ? <p className="thread__excerpt muted">{happening.excerpt}</p> : null}

      <div className="thread__meta">
        <WriterChip
          pubkey={happening.writer.pubkey}
          name={happening.writer.tag ?? undefined}
          size={18}
          linked={false}
        />
        <span className="mono faint">
          {where.length > 0 ? `${where.join(' · ')} · ` : ''}
          {happening.replyCount === 0
            ? 'nobody said anything yet'
            : `${happening.replyCount} ${happening.replyCount === 1 ? 'reply' : 'replies'}`}
        </span>
      </div>
    </Link>
  );
}
