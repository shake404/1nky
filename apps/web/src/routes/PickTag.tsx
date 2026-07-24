import { COPY } from '@1nky/protocol';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTag } from '../state/TagProvider.js';

const MAX = 24;

/**
 * The entire sign-up. One field, one button, under sixty seconds.
 *
 * Nothing is validated against a server because there is no server-side
 * notion of a name — collisions are expected and handled by showing the mark
 * everywhere instead of pretending names are unique.
 */
export function PickTag(): JSX.Element {
  const { createTag } = useTag();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Pick something.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createTag(trimmed);
      navigate('/', { replace: true });
    } catch {
      setError('Could not set that up. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="app app--bare">
      <div className="hero">
        <div>
          <span className="tape">step one of one</span>
          <h1 style={{ marginTop: 14 }}>{COPY.tag.pick}</h1>
        </div>

        <form className="stack stack--wide" onSubmit={submit}>
          <div className="field">
            <label htmlFor="tag-name" className="sr-only">
              Your tag
            </label>
            <input
              id="tag-name"
              className="input input--display"
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, MAX))}
              placeholder="TAG"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={MAX}
              enterKeyHint="go"
            />
            <p className="help">{COPY.tag.notUnique} Yours gets one the moment you pick.</p>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <button type="submit" className="btn btn--go btn--block sticker" disabled={busy}>
            {busy ? 'Setting up...' : "That's me"}
          </button>
        </form>

        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Nothing else to fill in. No email, no number, no confirmation.
        </p>

        <Link to="/restore" className="kicker" style={{ textDecoration: 'underline' }}>
          {COPY.tag.restore}
        </Link>
      </div>
    </div>
  );
}
