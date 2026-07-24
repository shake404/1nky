import { COPY } from '@1nky/protocol';
import { Link } from 'react-router-dom';

/**
 * First thing anyone sees. Two doors, no sign-up form, no cookie banner,
 * no explanation of what any of this is built on.
 */
export function Landing(): JSX.Element {
  return (
    <div className="app app--bare">
      <div className="hero">
        <div>
          <span className="tape">no name · no number · no trail</span>
          <h1 className="hero__mark chrome" style={{ marginTop: 14 }}>
            1NKY
          </h1>
        </div>

        <p style={{ fontSize: '1.15rem', maxWidth: '34ch' }}>
          Put your work up. Nobody asks who you are, because nobody here can find out.
        </p>

        <div className="stack">
          <Link to="/pick" className="btn btn--go btn--block sticker">
            {COPY.tag.pick}
          </Link>
          <Link to="/restore" className="btn btn--ghost btn--block">
            {COPY.tag.restore}
          </Link>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <p className="kicker">how it works</p>
          <p className="muted" style={{ fontSize: '0.92rem' }}>
            You pick a name. That is the whole thing. No email, no number, nothing to
            hand over to anyone who comes asking. Your pictures get scrubbed clean on
            your phone before they ever leave it.
          </p>
        </div>
      </div>
    </div>
  );
}
