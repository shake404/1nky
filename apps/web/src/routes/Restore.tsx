import { COPY } from '@1nky/protocol';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { importBlackbook } from '../lib/identity.js';
import { useTag } from '../state/TagProvider.js';

/**
 * Getting a tag back. Shared by onboarding ("Already got a tag?") and by
 * linking a second device — the payload is the same either way.
 */
export function Restore(): JSX.Element {
  const { restoreTag } = useTag();
  const navigate = useNavigate();
  const [contents, setContents] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      setContents(text);
      const found = /^TAG:\s*(.+)$/m.exec(text)?.[1]?.trim();
      if (found && !name) setName(found);
    } catch {
      setError('Could not read that file.');
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const secret = importBlackbook(contents, passphrase);
      await restoreTag(secret, name || 'unnamed');
      navigate('/', { replace: true });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.');
      setBusy(false);
    }
  };

  return (
    <div className="app app--bare">
      <div className="hero">
        <div>
          <span className="tape">welcome back</span>
          <h1 style={{ marginTop: 14 }}>{COPY.tag.restore}</h1>
        </div>

        <form className="stack stack--wide" onSubmit={submit}>
          <div className="field">
            <label htmlFor="bb-file">Upload your blackbook</label>
            <input
              id="bb-file"
              className="input"
              type="file"
              accept=".txt,text/plain"
              onChange={pickFile}
            />
          </div>

          <div className="field">
            <label htmlFor="bb-text">Or paste it here</label>
            <textarea
              id="bb-text"
              className="textarea mono"
              value={contents}
              onChange={(event) => setContents(event.target.value)}
              placeholder="----- BEGIN BLACKBOOK -----"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label htmlFor="bb-pass">Passphrase</label>
            <input
              id="bb-pass"
              className="input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="current-password"
              placeholder="Leave blank if you never set one"
            />
          </div>

          <div className="field">
            <label htmlFor="bb-name">Your tag</label>
            <input
              id="bb-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, 24))}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="TAG"
            />
            <p className="help">
              Only the name — the mark comes back on its own and proves it is you.
            </p>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <button type="submit" className="btn btn--go btn--block sticker" disabled={busy || !contents.trim()}>
            {busy ? 'Checking...' : 'Get my tag back'}
          </button>
        </form>

        <Link to="/pick" className="kicker" style={{ textDecoration: 'underline' }}>
          Start a new one instead
        </Link>
      </div>
    </div>
  );
}
