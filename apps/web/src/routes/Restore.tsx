import { COPY } from '@1nky/protocol';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { resolveWriterInput } from '../lib/crews.js';
import { importBlackbook } from '../lib/identity.js';
import { openLockedCopy } from '../lib/recovery.js';
import { useTag } from '../state/TagProvider.js';

/**
 * Getting a tag back. Shared by onboarding ("Already got a tag?") and by
 * linking a second device — the payload is the same either way.
 *
 * Two doors, and the file is still the front one. The second is for somebody who
 * opted into a locked copy earlier: they hand over the link they were told to
 * save plus the passphrase, and what comes back is opened here, on the device,
 * before it becomes their tag again.
 */
export function Restore(): JSX.Element {
  const { restoreTag } = useTag();
  const navigate = useNavigate();
  const [contents, setContents] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // The locked-copy path.
  const [lockedOpen, setLockedOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [lockedPass, setLockedPass] = useState('');
  const [lockedName, setLockedName] = useState('');
  const [lockedError, setLockedError] = useState('');
  const [lockedBusy, setLockedBusy] = useState(false);

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

  const fromLockedCopy = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setLockedError('');

    // Accepts the saved link or the bare id — never a mark, which is one-way on
    // purpose and could not be turned back into an address anyway.
    const id = resolveWriterInput(handle);
    if (!id) {
      setLockedError('Could not make out that link.');
      return;
    }

    setLockedBusy(true);
    try {
      const secret = await openLockedCopy(id, lockedPass);
      await restoreTag(secret, lockedName || 'unnamed');
      navigate('/', { replace: true });
    } catch (problem) {
      setLockedError(problem instanceof Error ? problem.message : 'That did not work.');
      setLockedBusy(false);
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

        <hr className="rule" />

        {lockedOpen ? (
          <form className="stack stack--wide" onSubmit={fromLockedCopy}>
            <div>
              <h3>Set up recovery earlier?</h3>
              <p className="help">
                Paste the link you saved and the passphrase you picked. It opens on this device.
              </p>
            </div>

            <div className="field">
              <label htmlFor="lock-handle">Your recovery link</label>
              <input
                id="lock-handle"
                className="input mono"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://1nky.com/w/..."
              />
            </div>

            <div className="field">
              <label htmlFor="lock-pass">Passphrase</label>
              <input
                id="lock-pass"
                className="input"
                type="password"
                value={lockedPass}
                onChange={(event) => setLockedPass(event.target.value)}
                autoComplete="current-password"
              />
            </div>

            <div className="field">
              <label htmlFor="lock-name">Your tag</label>
              <input
                id="lock-name"
                className="input"
                value={lockedName}
                onChange={(event) => setLockedName(event.target.value.slice(0, 24))}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="TAG"
              />
            </div>

            {lockedError ? <p className="error">{lockedError}</p> : null}

            <button
              type="submit"
              className="btn btn--go btn--block sticker"
              disabled={lockedBusy || !handle.trim() || !lockedPass}
            >
              {lockedBusy ? 'Checking...' : 'Get my tag back'}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--block"
            onClick={() => setLockedOpen(true)}
          >
            Set up recovery earlier?
          </button>
        )}

        <Link to="/pick" className="kicker" style={{ textDecoration: 'underline' }}>
          Start a new one instead
        </Link>
      </div>
    </div>
  );
}
