import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { getPref } from '../lib/db.js';
import { fetchFeed, type Flick } from '../lib/feed.js';

/** The global wall: newest first, infinite. */
export function Feed(): JSX.Element {
  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [buffed, setBuffed] = useState<string[]>([]);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    void getPref<string[]>('buffed', []).then(setBuffed);
  }, []);

  const loadMore = useCallback(
    async (from: string | null, replace: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const page = await fetchFeed(from);
        setFailed(false);
        setFlicks((current) => {
          const merged = replace ? page.flicks : [...current, ...page.flicks];
          const seen = new Set<string>();
          return merged.filter((flick) => !seen.has(flick.id) && seen.add(flick.id));
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
    [],
  );

  useEffect(() => {
    void loadMore(null, true);
  }, [loadMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || exhausted || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore(cursor, false);
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, exhausted, loadMore]);

  const visible = flicks.filter((flick) => !buffed.includes(flick.id));

  return (
    <div className="shell">
      {visible.length === 0 && !loading ? (
        <div className="empty">
          <h2>Nothing on the wall yet.</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            First one&apos;s yours.
          </p>
          <Link to="/post" className="btn btn--go sticker">
            Put something up
          </Link>
          {failed ? <p className="help" style={{ marginTop: 20 }}>Could not reach the wall.</p> : null}
        </div>
      ) : (
        <div className="wall">
          {visible.map((flick) => (
            <FlickCard key={flick.id} flick={flick} />
          ))}
        </div>
      )}

      <div ref={sentinel} style={{ height: 1 }} />
      {loading ? <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>loading</p> : null}
      {exhausted && visible.length > 0 ? (
        <p className="faint mono" style={{ textAlign: 'center', padding: '24px 0 40px' }}>
          that&apos;s the whole wall
        </p>
      ) : null}
    </div>
  );
}
