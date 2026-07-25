import { Link } from 'react-router-dom';
import { ThreadCompose } from '../components/ThreadCompose.js';
import { ThreadList, useBoardThreads } from '../components/ThreadList.js';
import { HOLLER_BOARD } from '../lib/boards.js';
import { useTag } from '../state/TagProvider.js';

/**
 * `/holler` — tell us what is wrong with this place.
 *
 * Deliberately not a form that emails anybody: it is a board, read and written
 * with exactly the same code as every other board (see {@link useBoardThreads}
 * and {@link ThreadCompose}), pinned to one slug. That is the point of the copy
 * at the top — a complaint here costs a writer nothing more than a post, and
 * everybody can read the answer.
 *
 * The one difference from a city board: what goes up here starts out pinned,
 * because feedback that evaporates overnight is feedback nobody acted on. The
 * lifetime selector is still right there for anyone who wants their piece gone
 * by morning.
 */
export function Holler(): JSX.Element {
  const { tag } = useTag();
  const { threads, loading, failed, cursor, more } = useBoardThreads(HOLLER_BOARD);

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <span className="tape">holler</span>
        <h2 style={{ marginTop: 12 }}>Holler at us</h2>
      </div>

      <p style={{ fontSize: '1.05rem' }}>
        Same rules as the wall: no name, no number, just your tag. Say what&apos;s broken,
        what&apos;s missing, what should burn.
      </p>

      <p className="help">
        It rides the same rails as everything else here — nothing extra is asked for and
        nothing extra is kept. What you put up carries your tag the way a flick does, so
        you can buff it whenever you want, and everybody can read it, including whoever
        has to fix it.
      </p>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Link to="/roadmap" className="btn btn--ghost btn--sm sticker">
          See what&apos;s coming
        </Link>
        <Link to={`/b/${HOLLER_BOARD}`} className="btn btn--ghost btn--sm sticker">
          Flicks on this board
        </Link>
      </div>

      {tag ? (
        <section className="stack stack--wide">
          <hr className="rule" />
          <h3>Say it</h3>
          <ThreadCompose
            board={HOLLER_BOARD}
            defaultDuration="pinned"
            bodyLabel={"What's the problem"}
            bodyPlaceholder="What broke, what is missing, what you would burn."
            submitLabel="Holler"
            postedLabel="Heard."
          />
        </section>
      ) : null}

      <hr className="rule" />

      <section className="stack stack--wide">
        <h3>What people have said</h3>

        {threads.length === 0 && !loading ? (
          <div className="empty">
            <h2>Nobody&apos;s hollered yet.</h2>
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
      </section>
    </div>
  );
}
