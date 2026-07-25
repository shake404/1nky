import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBoards, type BoardSummary } from '../lib/boards.js';
import { ago } from '../lib/platform.js';

/**
 * `/boards` — every wall anybody has claimed.
 *
 * City boards get the grid, because that is how writers actually look for
 * things: by where. Whatever else exists (a region, some one-off) gets a quiet
 * row underneath rather than its own furniture.
 *
 * Two reads, on purpose: the city list is asked for by name so the wall can
 * order and count it properly, and a second unfiltered read is what turns up
 * anything that is not a city. A failure on the second one costs nothing — the
 * page is still the city grid.
 */
export function Boards(): JSX.Element {
  const [cities, setCities] = useState<BoardSummary[]>([]);
  const [others, setOthers] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [cityResult, allResult] = await Promise.allSettled([fetchBoards('city'), fetchBoards()]);
      if (!live) return;

      const cityBoards = cityResult.status === 'fulfilled' ? cityResult.value : [];
      const all = allResult.status === 'fulfilled' ? allResult.value : [];
      const claimed = new Set(cityBoards.map((b) => b.slug));

      setCities(cityBoards);
      setOthers(all.filter((b) => b.kind !== 'city' && !claimed.has(b.slug)));
      setFailed(cityResult.status === 'rejected' && allResult.status === 'rejected');
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <span className="tape">walls</span>
        <h2 style={{ marginTop: 12 }}>Boards</h2>
      </div>

      {cities.length === 0 ? (
        <div className="empty">
          <h2>No walls claimed yet.</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            Start one by posting to it.
          </p>
          <Link to="/post" className="btn btn--go sticker">
            Put something up
          </Link>
          {failed ? (
            <p className="help" style={{ marginTop: 20 }}>
              Could not reach the wall.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="board-grid">
          {cities.map((board) => (
            <BoardCard key={board.slug} board={board} />
          ))}
        </div>
      )}

      {others.length > 0 ? (
        <section className="stack">
          <hr className="rule" />
          <h3>Everything else</h3>
          <div className="chips">
            {others.map((board) => (
              <Link key={board.slug} to={`/b/${board.slug}`} className="chip">
                {board.slug}
                <span className="chip__count">{board.threadCount + board.flickCount}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function BoardCard({ board }: { board: BoardSummary }): JSX.Element {
  const named = board.title.toLowerCase() !== board.slug;
  return (
    <Link to={`/b/${board.slug}`} className="board-card">
      <span className="board-card__slug">{board.slug}</span>
      {named ? <span className="board-card__title muted">{board.title}</span> : null}
      <span className="board-card__counts mono">
        {board.threadCount} {board.threadCount === 1 ? 'thread' : 'threads'}
        {' · '}
        {board.flickCount} {board.flickCount === 1 ? 'flick' : 'flicks'}
      </span>
      <span className="board-card__latest mono faint">
        {board.latestAt ? `last up ${ago(board.latestAt)}` : 'nothing up yet'}
      </span>
    </Link>
  );
}
