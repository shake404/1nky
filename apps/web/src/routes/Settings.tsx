import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { IgnoreWriter, useIgnoredWriters } from '../components/IgnoreWriter.js';
import { QrBlock } from '../components/QrBlock.js';
import { API_BASE, MEDIA_BASE, POW_BITS, RELAY_WS_URL, SHOW_FLAGS } from '../lib/config.js';
import { exportBlackbook } from '../lib/identity.js';
import { loadModKey } from '../lib/mod.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/** Everything about this device and this tag. */
export function Settings(): JSX.Element {
  const { tag, persisted } = useTag();
  const { say } = useToast();
  const [linkPayload, setLinkPayload] = useState<string | null>(null);
  const [linkPass, setLinkPass] = useState('');
  const [linking, setLinking] = useState(false);
  const [hasModKey, setHasModKey] = useState(false);
  const ignored = useIgnoredWriters();

  // The mod door only exists in this list for someone who already has the key
  // on this device. Everybody else never learns the screen is there.
  useEffect(() => {
    void loadModKey().then((key) => setHasModKey(Boolean(key)));
  }, []);

  if (!tag) return <div className="shell empty" />;

  const makeLink = async (): Promise<void> => {
    if (linkPass.length < 8) {
      say('Use at least 8 characters.', 'hazard');
      return;
    }
    setLinking(true);
    try {
      const exported = await exportBlackbook(tag, linkPass);
      setLinkPayload(exported.payload);
    } catch {
      say('Could not make the block.', 'hazard');
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="shell pad stack stack--wide">
      <h2>Setup</h2>

      <div className="row" style={{ gap: 14 }}>
        <Identicon pubkey={tag.pubkey} size={56} />
        <div>
          <p className="display" style={{ fontSize: '1.5rem' }}>
            {tag.name}
          </p>
          <p className="mono muted">{tag.mark}</p>
        </div>
      </div>
      <p className="help">{COPY.mark.hint}</p>

      <Link to="/profile/edit" className="btn btn--ghost btn--sm sticker">
        Edit your tag
      </Link>

      <hr className="rule" />

      <section className="stack">
        <h3>{COPY.blackbook.label}</h3>
        <div className="settings-row">
          <span className={tag.backedUp ? 'muted' : 'hazard'}>
            {tag.backedUp ? 'Saved.' : COPY.blackbook.nag}
          </span>
          <Link to="/backup" className="btn btn--go btn--sm sticker">
            {COPY.blackbook.action}
          </Link>
        </div>
        <p className="help">{COPY.blackbook.warning}</p>
      </section>

      <hr className="rule" />

      <section className="stack">
        <h3>{COPY.blackbook.linkDevice}</h3>
        <p className="help">
          Make a scannable block, open 1NKY on the other device, and choose
          &ldquo;{COPY.tag.restore}&rdquo;.
        </p>
        {linkPayload ? (
          <>
            <QrBlock value={linkPayload} size={240} />
            <p className="help hazard">
              Anyone who photographs this and knows the passphrase becomes you. Close it when
              you are done.
            </p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLinkPayload(null)}>
              Hide it
            </button>
          </>
        ) : (
          <div className="field">
            <label htmlFor="link-pass">Passphrase for the block</label>
            <input
              id="link-pass"
              className="input"
              type="password"
              value={linkPass}
              onChange={(event) => setLinkPass(event.target.value)}
              autoComplete="new-password"
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void makeLink()}
              disabled={linking}
            >
              {linking ? 'Making it...' : 'Show the block'}
            </button>
          </div>
        )}
      </section>

      <hr className="rule" />

      <section className="stack">
        <h3>{COPY.crew.label}</h3>
        <p className="muted">{COPY.blackbook.warning}</p>
        <div className="settings-row">
          <span className="muted">Make a crew to post under a shared tag.</span>
          <Link to="/crew/new" className="btn btn--go btn--sm sticker">
            {COPY.crew.action}
          </Link>
        </div>
        <p className="help">
          To <em>post as</em> a crew later, import its blackbook through &ldquo;{COPY.tag.restore}&rdquo; — that swaps
          this device&apos;s single active tag to the crew. Restore your own blackbook when you are done.
        </p>
      </section>

      <hr className="rule" />

      <section className="stack">
        <h3>Ignored writers</h3>
        {ignored.length === 0 ? (
          <p className="muted">Nobody. Your wall is whoever is on it.</p>
        ) : (
          <ul className="list-reset stack" style={{ gap: 10 }}>
            {ignored.map((pubkey) => (
              <li key={pubkey} className="mod-row">
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <Identicon pubkey={pubkey} size={24} />
                  <span className="mono">{fingerprint(pubkey)}</span>
                </div>
                <IgnoreWriter pubkey={pubkey} look="button" />
              </li>
            ))}
          </ul>
        )}
        <p className="help">Their work stays up for everyone else — you just do not see it.</p>
      </section>

      <hr className="rule" />

      <section className="stack">
        <h3>This device</h3>
        <div className="settings-row">
          <span className="muted">Storage held onto</span>
          <span className={persisted ? 'mono' : 'mono hazard'}>{persisted ? 'yes' : 'not promised'}</span>
        </div>
        <p className="help">
          If that says otherwise, install 1NKY to your home screen — {COPY.blackbook.installPrompt.toLowerCase()}
        </p>
      </section>

      {hasModKey ? (
        <>
          <hr className="rule" />
          <section className="stack">
            <h3>Mod console</h3>
            <div className="settings-row">
              <span className="muted">Flags waiting, and who is banned.</span>
              <Link to="/mod" className="btn btn--ghost btn--sm sticker">
                Open it
              </Link>
            </div>
          </section>
        </>
      ) : null}

      <hr className="rule" />

      <section className="stack">
        <h3>This place</h3>
        <div className="settings-row">
          <span className="muted">Broken, missing, or just wrong — say it out loud.</span>
          <Link to="/holler" className="btn btn--go btn--sm sticker">
            Holler at us
          </Link>
        </div>
        <div className="settings-row">
          <span className="muted">What&apos;s up already and what&apos;s getting built next.</span>
          <Link to="/roadmap" className="btn btn--ghost btn--sm sticker">
            What&apos;s coming
          </Link>
        </div>
        <p className="help">
          A holler is an ordinary post on an ordinary board. Same rules as the wall — no
          name, no number, just your tag.
        </p>
      </section>

      <hr className="rule" />

      <section className="stack">
        <h3 className="hazard">{COPY.hangItUp.label}</h3>
        <p className="muted">{COPY.hangItUp.blurb}</p>
        <Link to="/hang-it-up" className="btn btn--danger btn--block">
          {COPY.hangItUp.label}
        </Link>
      </section>

      {SHOW_FLAGS ? (
        <>
          <hr className="rule" />
          <section className="stack">
            <h3>Diagnostics</h3>
            <ul className="list-reset mono muted" style={{ fontSize: '0.72rem', lineHeight: 1.9 }}>
              <li>wall: {RELAY_WS_URL}</li>
              <li>reads: {API_BASE}</li>
              <li>pictures: {MEDIA_BASE}</li>
              <li>
                work: {POW_BITS.new}/{POW_BITS.post}/{POW_BITS.reaction}
              </li>
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
