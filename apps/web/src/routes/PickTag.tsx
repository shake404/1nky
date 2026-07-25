import { COPY } from '@1nky/protocol';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { NOT_A_PUT_ON, readPutOnCode } from '../lib/invites.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const MAX = 24;

/**
 * The entire sign-up. One field, one button, under sixty seconds.
 *
 * Nothing is validated against a server because there is no server-side
 * notion of a name — collisions are expected and handled by showing the mark
 * everywhere instead of pretending names are unique.
 *
 * One optional extra: whoever arrives holding a put-on can hand it over here,
 * either by following the link somebody sent them or by pasting it in. This is
 * the ONLY place it can go — a put-on rides on a writer's first profile, and
 * there is no second first profile. Everything else about onboarding is
 * unchanged: a writer with no put-on sees the same one field and one button.
 */
export function PickTag(): JSX.Element {
  const { createTag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromLink = params.get('puton') ?? '';
  const [name, setName] = useState('');
  const [code, setCode] = useState(fromLink);
  // The paste field stays out of the way unless it is wanted — or unless they
  // arrived on a link, in which case it is already filled in.
  const [showCode, setShowCode] = useState(fromLink !== '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const typed = code.trim();
  const putOn = useMemo(() => readPutOnCode(code), [code]);
  const badCode = typed !== '' && putOn === null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Pick something.');
      return;
    }
    // Refuse rather than quietly drop it: a put-on only counts on this one
    // event, so going through without it would waste theirs for good.
    if (badCode) {
      setError(NOT_A_PUT_ON);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createTag(trimmed, putOn ?? undefined);
      if (putOn) say("You're on.");
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

          {showCode ? (
            <div className="field">
              <label htmlFor="put-on-code">Got put on? Paste it here.</label>
              <input
                id="put-on-code"
                className="input mono"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="what they handed you"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {badCode ? (
                <p className="error">{NOT_A_PUT_ON}</p>
              ) : putOn ? (
                <p className="help">Somebody put you on. You skip the line on your first post.</p>
              ) : (
                <p className="help">Only if a writer already on here handed you something. Optional.</p>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="kicker"
              style={{ background: 'none', border: 0, padding: 0, textDecoration: 'underline', cursor: 'pointer', textAlign: 'left' }}
              onClick={() => setShowCode(true)}
            >
              Got put on? Paste it here.
            </button>
          )}

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
