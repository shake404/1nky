import { getPublicKey } from '@1nky/protocol';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { saveCrewKey } from '../lib/crew-keys.js';
import { linkCrewToFounder, saveFoundedCrew } from '../lib/crews.js';
import { importBlackbook } from '../lib/identity.js';
import { fetchProfile } from '../lib/profiles.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * `/crew/import` — bring a crew blackbook onto THIS device.
 *
 * The crew secret only exists where someone holds the blackbook. Founding a
 * crew saves it here automatically, but a founder on a new browser — or a
 * member who was handed the blackbook — had no way in until this screen. It
 * writes ONLY the separate crew keyring (`crewkeys`) and the founded-crews
 * pointer; the writer's own single-slot tag is never touched.
 */
export function ImportCrew(): JSX.Element {
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();
  const [contents, setContents] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setContents(await file.text());
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
      const crewPubkey = getPublicKey(secret);

      // The crew's own kind-0 carries its name; a miss reads as "crew".
      const meta = await fetchProfile(crewPubkey).catch(() => null);
      const name = meta?.name?.trim() || 'crew';

      await saveCrewKey({ pubkey: crewPubkey, secret, name });
      await saveFoundedCrew({ pubkey: crewPubkey, name, foundedByMe: true });

      // Best effort: put the crew on this writer's own page too, so it shows
      // up everywhere their tag does. Never blocks the import itself.
      if (tag) await linkCrewToFounder(tag, crewPubkey).catch(() => undefined);

      say('You hold this crew on this device now.');
      navigate(`/crew/${crewPubkey}`, { replace: true });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.');
      setBusy(false);
    }
  };

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">crew</span>
        <h2 style={{ marginTop: 12 }}>Bring in a crew blackbook</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          Hold the crew&apos;s blackbook? Load it here and this device can run the
          crew — roster, name, the works. Your own tag stays exactly as it is.
        </p>
      </div>

      <form className="stack stack--wide" onSubmit={submit}>
        <div className="field">
          <label htmlFor="cbb-file">Upload the crew blackbook</label>
          <input
            id="cbb-file"
            className="input"
            type="file"
            accept=".txt,text/plain"
            onChange={pickFile}
          />
        </div>

        <div className="field">
          <label htmlFor="cbb-text">Or paste it here</label>
          <textarea
            id="cbb-text"
            className="textarea mono"
            value={contents}
            onChange={(event) => setContents(event.target.value)}
            placeholder="----- BEGIN BLACKBOOK -----"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="cbb-pass">Passphrase</label>
          <input
            id="cbb-pass"
            className="input"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="off"
            placeholder="Leave blank if the crew never set one"
          />
        </div>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" className="btn btn--go btn--block sticker" disabled={busy || !contents.trim()}>
          {busy ? 'Checking...' : 'Bring it in'}
        </button>
      </form>

      <Link to="/crews" className="kicker" style={{ textDecoration: 'underline' }}>
        Back to your crews
      </Link>
    </div>
  );
}
