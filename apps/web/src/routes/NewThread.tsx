import { normalizeBoard } from '@1nky/protocol';
import { Link, useParams } from 'react-router-dom';
import { ThreadCompose } from '../components/ThreadCompose.js';
import { useTag } from '../state/TagProvider.js';

/**
 * `/b/:slug/new` — start a thread on a board.
 *
 * The form itself is {@link ThreadCompose}: the lifetime selector, the caps and
 * the work are shared with /holler, which is the same act on a fixed board.
 */
export function NewThread(): JSX.Element {
  const { slug = '' } = useParams();
  const { tag } = useTag();

  const board = normalizeBoard(slug);

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <Link to={`/b/${board}`} className="tape">
          {board}
        </Link>
        <h2 style={{ marginTop: 12 }}>Start one</h2>
      </div>

      <ThreadCompose board={board} />
    </div>
  );
}
