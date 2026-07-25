import { useState } from 'react';
import { passphraseStrength } from '../lib/identity.js';
import { copyText } from '../lib/platform.js';
import {
  dropLockedCopy,
  lockedCopy,
  NoLockedCopyError,
  putLockedCopy,
  recoveryHandle,
  RecoveryDarkError,
} from '../lib/recovery.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * Settings → Recovery. Optional, and it says so first.
 *
 * The blackbook warning is not softened anywhere else on the site and it is not
 * softened here: this does not create a recovery desk, because the thing that
 * gets kept cannot be opened by the people keeping it. The passphrase is used on
 * this device and never sent. Lose the file AND the passphrase and the tag is
 * gone, same as always — which is exactly what the copy says out loud, above the
 * button, before anybody opts in.
 *
 * The endpoints ship dark. A 404 means the feature is off, not that anything
 * broke, so the section stays exactly where it is and says so.
 */
export function Recovery(): JSX.Element | null {
  const { tag } = useTag();
  const { say } = useToast();

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [handle, setHandle] = useState<string | null>(null);

  if (!tag) return null;

  const strength = passphraseStrength(passphrase);

  const optIn = async (): Promise<void> => {
    setError('');
    if (passphrase.trim().length < 8) {
      setError('Make it at least 8 characters.');
      return;
    }
    if (passphrase !== confirm) {
      setError('Those do not match.');
      return;
    }

    setBusy(true);
    try {
      // Locked here, on this device. The passphrase goes no further than this
      // line; what leaves is the locked payload.
      const payload = lockedCopy(tag.secret, passphrase);
      await putLockedCopy(tag.secret, payload);
      setPassphrase('');
      setConfirm('');
      setHandle(recoveryHandle(tag.pubkey));
      say('Locked copy kept.');
    } catch (problem) {
      setError(
        problem instanceof RecoveryDarkError
          ? problem.message
          : problem instanceof Error && problem.message
            ? problem.message
            : 'That did not save. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await dropLockedCopy(tag.secret);
      setHandle(null);
      say('Locked copy removed.');
    } catch (problem) {
      setError(
        problem instanceof NoLockedCopyError || problem instanceof RecoveryDarkError
          ? problem.message
          : 'That did not come down. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack">
      <h3>Recovery</h3>
      <p className="muted">Optional. Nothing here happens unless you ask for it.</p>
      <p className="help">
        We keep a locked copy nobody can open — not even us. The passphrase never leaves this
        device. Lose both the file and the passphrase and the tag is gone, same as always.
      </p>

      {handle ? (
        <div className="panel stack">
          <p className="kicker">your recovery link</p>
          <p className="mono" style={{ overflowWrap: 'anywhere' }}>
            {handle}
          </p>
          <p className="help">Save this link — it is how you point at the locked copy later.</p>
          <div className="row" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void copyText(handle).then((ok) => {
                  if (ok) say('Copied.');
                  else say('Copy it by hand — this browser would not.', 'hazard');
                });
              }}
            >
              Copy it
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHandle(null)}>
              Hide it
            </button>
          </div>
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="recovery-pass">Passphrase for the locked copy</label>
        <input
          id="recovery-pass"
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
        <label htmlFor="recovery-pass2">Again</label>
        <input
          id="recovery-pass2"
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
        className="btn btn--go btn--sm sticker"
        onClick={() => void optIn()}
        disabled={busy}
      >
        {busy ? 'Locking it...' : 'Keep a locked copy'}
      </button>

      <div className="settings-row">
        <span className="muted">Changed your mind?</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void remove()}
          disabled={busy}
        >
          Remove the locked copy
        </button>
      </div>
    </section>
  );
}
