import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { ThreadList, useBoardThreads } from '../components/ThreadList.js';
import { fetchFeed, type Flick } from '../lib/feed.js';
import { canonicalWall } from '../lib/walls.js';
import { useTag } from '../state/TagProvider.js';

type View = 'threads' | 'flicks';

/**
 * `/b/:slug` — one board.
 *
 * Two things live on a board and they are read completely differently, so they
 * are two views rather than one mixed column: what people are SAYING (threads,
 * newest activity first) and what people have PUT UP (the same wall grid as
 * everywhere else, filtered to this board).
 *
 * `/b/sf` lands on `/b/san-francisco`. The redirect uses the same alias map the
 * posting form does, so a link somebody painted on a wall two years ago still
 * arrives somewhere, and the nicknames stop splitting a city's feed. Posts
 * already signed with an alias slug are deliberately left alone — they are
 * signed events, and rewriting them is not a thing anyone can do. The old feed
 * stays readable at its own address; new posts simply stop landing there.
 */
export function Board(): JSX.Element {
  const { slug = '' } = useParams();
  const canonical = canonicalWall(slug);
  // Redirected BEFORE the page mounts — a thin wrapper with no data hooks in
  // it, so an alias never fires a fetch for a feed we are about to leave.
  if (canonical && canonical !== slug) return <Navigate to={`/b/${canonical}`} replace />;
  return <BoardPage slug={canonical} />;
}

function BoardPage({ slug }: { slug: string }): JSX.Element {
  const { tag } = useTag();

  const [view, setView] = useState<View>('threads');
  const { board, threads, loading, failed, cursor, more } = useBoardThreads(slug);

  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [flicksLoaded, setFlicksLoaded] = useState(false);

  // The board's wall is only fetched once somebody asks to see it.
  useEffect(() => {
    if (view !== 'flicks' || flicksLoaded) return;
    let live = true;
    void fetchFeed(null, undefined, slug)
      .then((page) => {
        if (!live) return;
        setFlicks(page.flicks);
        setFlicksLoaded(true);
      })
      .catch(() => {
        if (live) setFlicksLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [view, flicksLoaded, slug]);

  const name = board?.title ?? slug;

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <Link to="/boards" className="tape">
          walls
        </Link>
        <h2 style={{ marginTop: 12 }}>{name}</h2>
        <p className="mono faint" style={{ marginTop: 8 }}>
          {board?.regionSlug ? `${board.regionSlug} · ` : ''}
          {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        </p>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`chip ${view === 'threads' ? 'chip--active' : ''}`}
          onClick={() => setView('threads')}
        >
          talk
        </button>
        <button
          type="button"
          className={`chip ${view === 'flicks' ? 'chip--active' : ''}`}
          onClick={() => setView('flicks')}
        >
          flicks
        </button>
      </div>

      {view === 'threads' ? (
        <>
          {tag ? (
            <Link to={`/b/${slug}/new`} className="btn btn--go btn--block sticker">
              Start one
            </Link>
          ) : null}

          {threads.length === 0 && !loading ? (
            <div className="empty">
              <h2>Nobody&apos;s talking here.</h2>
              <p className="muted">First word&apos;s yours.</p>
              {failed ? (
                <p className="help" style={{ marginTop: 20 }}>
                  Could not reach the wall.
                </p>
              ) : null}
            </div>
          ) : (
            <ThreadList threads={threads} />
          )}

          {loading ? (
            <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
              loading
            </p>
          ) : null}

          {cursor && !loading ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={more}>
              More
            </button>
          ) : null}
        </>
      ) : (
        <>
          {!flicksLoaded ? (
            <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
              loading
            </p>
          ) : flicks.length === 0 ? (
            <div className="empty">
              <h2>Nothing up on this wall.</h2>
              <p className="muted">Be the first.</p>
            </div>
          ) : (
            <div className="wall">
              {flicks.map((flick) => (
                <FlickCard key={flick.id} flick={flick} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Kept as an export here because the search results page renders board threads
 * through it. The implementation moved to the shared thread list.
 */
export { ThreadRowCard } from '../components/ThreadList.js';
