import { COPY } from '@1nky/protocol';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QrBlock } from '../components/QrBlock.js';
import { exportBlackbook, passphraseStrength, UNLOCKED_WARNING, type BlackbookExport } from '../lib/identity.js';
import { downloadText } from '../lib/platform.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * Blackbook export.
 *
 * Two paths: locked (a passphrase, scrypt-hardened) and unlocked (a loud
 * warning and nothing else). We do not soften the unlocked path — the file
 * IS the tag and there is no recovery desk.
 */
export function Backup(): JSX.Element {
  const { tag, setBackedUp } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [skipping, setSkipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BlackbookExport | null>(null);
  const [error, setError] = useState('');

  if (!tag) return <div className="shell empty" />;

  const strength = passphraseStrength(passphrase);

  const run = async (skip: boolean): Promise<void> => {
    setError('');
    if (!skip) {
      if (passphrase.length < 8) {
        setError('Make it at least 8 characters.');
        return;
      }
      if (passphrase !== confirm) {
        setError('Those do not match.');
        return;
      }
    }
    setBusy(true);
    try {
      // scrypt at log2(N)=16 takes about a second on a phone. That wait is
      // the point — it is what makes a short passphrase survivable.
      const exported = await exportBlackbook(tag, skip ? '' : passphrase);
      setResult(exported);
      downloadText(exported.filename, exported.contents);
      await setBackedUp();
      say('Blackbook saved. Put it somewhere safe.');
    } catch {
      setError('Could not make the file. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="shell pad stack stack--wide">
        <div>
          <span className="tape">saved</span>
          <h2 style={{ marginTop: 12 }}>Your blackbook</h2>
        </div>

        <div className="panel panel--hazard">
          <p>
            <strong>{COPY.blackbook.warning}</strong>
          </p>
        </div>

        {result.locked ? null : (
          <div className="panel panel--hazard">
            <p className="hazard">
              <strong>{UNLOCKED_WARNING}</strong>
            </p>
          </div>
        )}

        <p className="muted">
          The file just downloaded. Screenshot or print the block below as a second copy.
        </p>

        <QrBlock value={result.payload} size={240} />

        <div className="stack">
          <button
            type="button"
            className="btn btn--ghost btn--block"
            onClick={() => downloadText(result.filename, result.contents)}
          >
            Download again
          </button>
          <button type="button" className="btn btn--go btn--block sticker" onClick={() => navigate('/')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">do this now</span>
        <h2 style={{ marginTop: 12 }}>{COPY.blackbook.action}</h2>
      </div>

      <div className="panel panel--hazard">
        <p>
          <strong>{COPY.blackbook.warning}</strong>
        </p>
      </div>

      {skipping ? (
        <div className="stack">
          <div className="panel panel--hazard stack">
            <h3 className="hazard">Hold on.</h3>
            <p>{UNLOCKED_WARNING}</p>
            <p className="muted">
              Anyone who finds this file — on a shared laptop, in a downloads folder, in a
              backup you forgot about — becomes you. There is no way to undo that.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--danger btn--block"
            onClick={() => void run(true)}
            disabled={busy}
          >
            {busy ? 'Making it...' : 'I understand — save it unlocked'}
          </button>
          <button type="button" className="btn btn--ghost btn--block" onClick={() => setSkipping(false)}>
            Use a passphrase instead
          </button>
        </div>
      ) : (
        <div className="stack stack--wide">
          <div className="field">
            <label htmlFor="pass">{COPY.blackbook.passphrasePrompt}</label>
            <input
              id="pass"
              className="input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              placeholder="Something you will not forget"
            />
            <div className="meter" aria-hidden="true">
              {[1, 2, 3, 4].map((step) => (
                <span key={step} className={strength.score >= step ? `on-${strength.score}` : ''} />
              ))}
            </div>
            <p className="help">{strength.hint}</p>
          </div>

          <div className="field">
            <label htmlFor="pass2">Again</label>
            <input
              id="pass2"
              className="input"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </div>

          {error ? <p className="error">{error}</p> : null}

          <button
            type="button"
            className="btn btn--go btn--block sticker"
            onClick={() => void run(false)}
            disabled={busy}
          >
            {busy ? 'Locking it...' : 'Save my blackbook'}
          </button>

          <button type="button" className="btn btn--ghost btn--block" onClick={() => setSkipping(true)}>
            Skip the passphrase
          </button>
        </div>
      )}
    </div>
  );
}
