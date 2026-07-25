import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BeefChip } from '../components/BeefChip.js';
import { FlickCard } from '../components/FlickCard.js';
import { WriterChip } from '../components/WriterChip.js';
import {
  beefClock,
  fetchBoard,
  threadHeadline,
  type BoardMeta,
  type ThreadRow,
} from '../lib/boards.js';
import { fetchFeed, type Flick } from '../lib/feed.js';
import { ago } from '../lib/platform.js';
import { useTag } from '../state/TagProvider.js';

type View = 'threads' | 'flicks';

/**
 * `/b/:slug` — one board.
 *
 * Two things live on a board and they are read completely differently, so they
 * are two views rather than one mixed column: what people are SAYING (threads,
 * newest activity first) and what people have PUT UP (the same wall grid as
 * everywhere else, filtered to this board).
 */
export function Board(): JSX.Element {
  const { slug = '' } = useParams();
  const { tag } = useTag();

  const [view, setView] = useState<View>('threads');
  const [board, setBoard] = useState<BoardMeta | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [flicksLoaded, setFlicksLoaded] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      setLoading(true);
      try {
        const page = await fetchBoard(slug, from);
        setBoard(page.board);
        setThreads((current) => {
          const merged = from ? [...current, ...page.threads] : page.threads;
          const seen = new Set<string>();
          return merged.filter((t) => !seen.has(t.id) && seen.add(t.id));
        });
        setCursor(page.cursor);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    setThreads([]);
    setCursor(null);
    void load(null);
  }, [load]);

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
  const alive = threads.filter((t) => !beefClock(t.expiresAt)?.gone);

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <Link to="/boards" className="tape">
          walls
        </Link>
        <h2 style={{ marginTop: 12 }}>{name}</h2>
        <p className="mono faint" style={{ marginTop: 8 }}>
          {board?.regionSlug ? `${board.regionSlug} · ` : ''}
          {alive.length} {alive.length === 1 ? 'thread' : 'threads'}
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

          {alive.length === 0 && !loading ? (
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
            <ul className="list-reset stack">
              {alive.map((thread) => (
                <li key={thread.id}>
                  <ThreadRowCard thread={thread} />
                </li>
              ))}
            </ul>
          )}

          {loading ? (
            <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
              loading
            </p>
          ) : null}

          {cursor && !loading ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load(cursor)}>
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

/** One row in the thread list. */
export function ThreadRowCard({ thread }: { thread: ThreadRow }): JSX.Element {
  const clock = beefClock(thread.expiresAt);
  const headline = threadHeadline(thread);
  const showExcerpt = Boolean(thread.subject && thread.excerpt.trim());

  return (
    <Link to={`/t/${thread.id}`} className="thread">
      <div className="thread__top">
        <span className="thread__subject">{headline}</span>
        {clock ? <BeefChip clock={clock} /> : null}
      </div>

      {showExcerpt ? <p className="thread__excerpt muted">{thread.excerpt}</p> : null}

      <div className="thread__meta">
        <WriterChip pubkey={thread.writer.pubkey} name={thread.writer.tag ?? undefined} size={18} linked={false} />
        <span className="mono faint">
          {thread.replyCount === 0
            ? 'no replies'
            : `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`}
          {' · '}
          {ago(thread.lastReplyAt ?? thread.createdAt)}
        </span>
      </div>
    </Link>
  );
}
