import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ThreadCompose } from '../components/ThreadCompose.js';
import { canonicalWall } from '../lib/walls.js';
import { useTag } from '../state/TagProvider.js';

/**
 * `/b/:slug/new` — start a thread on a board.
 *
 * The form itself is {@link ThreadCompose}: the lifetime selector, the caps and
 * the work are shared with /holler, which is the same act on a fixed board.
 *
 * `?happening=1` opens with the date switch already flipped — that is the door
 * the happenings list sends somebody through when they came to post a jam.
 *
 * The board comes from the URL, so this is the OTHER way a wall gets named —
 * `canonicalWall` rather than a bare `normalizeBoard` means typing `/b/sf/new`
 * starts the thread on `san-francisco` instead of minting a second wall for the
 * same city. The query string rides along so `?happening=1` survives the hop.
 */
export function NewThread(): JSX.Element {
  const { slug = '' } = useParams();
  const [search] = useSearchParams();
  const { tag } = useTag();

  const board = canonicalWall(slug);
  const happening = search.get('happening') === '1';

  if (board && board !== slug) {
    const query = search.toString();
    return <Navigate to={`/b/${board}/new${query ? `?${query}` : ''}`} replace />;
  }

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <Link to={`/b/${board}`} className="tape">
          {board}
        </Link>
        <h2 style={{ marginTop: 12 }}>{happening ? 'Put one on' : 'Start one'}</h2>
      </div>

      <ThreadCompose board={board} defaultHappening={happening} />
    </div>
  );
}
