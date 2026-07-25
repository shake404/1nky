import { COPY, fingerprint } from '@1nky/protocol';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { QrBlock } from '../components/QrBlock.js';
import { Spraying } from '../components/Spraying.js';
import { POW_BITS } from '../lib/config.js';
import {
  createCrew,
  crewTemplates,
  type CreateCrewResult,
} from '../lib/crews.js';
import { exportBlackbook } from '../lib/identity.js';
import { downloadText } from '../lib/platform.js';
import { publishTemplate, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * `/crew/new` — mint a crew.
 *
 * A crew *is* its own keypair, so "starting a crew" means: generate a fresh
 * secret on this device, publish the crew's kind-0 profile and its kind-30078
 * definition (both signed by the crew's own key — NOT by the founder's tag),
 * then immediately export the crew's blackbook reusing the existing NIP-49
 * export + QR so the founder can hand it to members.
 *
 * Post-as-crew is the blackbook swap (Part 4.5): a member imports the crew
 * blackbook through the EXISTING restore flow, which swaps the single active
 * identity to the crew key. We deliberately do NOT build a multi-key store —
 * the existing single-identity design is untouched and all existing flows stay
 * stable. The tradeoff: only one tag is active at a time, and posting as the
 * crew means the writer's own tag is briefly not loaded. Document it here and
 * in the nav's "speaking as" indicator.
 */
export function CreateCrew(): JSX.Element {
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [result, setResult] = useState<CreateCrewResult | null>(null);
  const [blackbookPayload, setBlackbookPayload] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!tag) return <div className="shell empty" />;

  const run = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Pick a crew name first.');
      return;
    }
    setError('');
    setStage('spraying');
    setBusy(true);
    try {
      const created = await createCrew(trimmed, tag.pubkey, async (secret, pubkey, kind) => {
        const templates = crewTemplates(trimmed, tag.pubkey, fingerprint(pubkey));
        const template = kind === 'profile' ? templates.profile : templates.definition;
        // A brand-new crew pubkey has no history of its own; its first event
        // pays the newcomer's freight.
        await publishTemplate(secret, pubkey, template, POW_BITS.new, { onStage: setStage });
      });
      setResult(created);

      // Export the crew blackbook immediately — this is the one time the raw
      // crew secret is on screen; the founder hands it off.
      const exported = await exportBlackbook({ secret: created.secret, name: created.name }, passphrase);
      setBlackbookPayload(exported.payload);
      downloadText(exported.filename, exported.contents);
      say('Crew is up. Hand off the blackbook.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go up.');
      setStage(null);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="shell pad stack stack--wide">
        <div>
          <span className="tape">reppin&apos; it</span>
          <h2 style={{ marginTop: 12 }}>{result.name}</h2>
        </div>

        <div className="row" style={{ gap: 14 }}>
          <Identicon pubkey={result.pubkey} size={56} />
          <div>
            <p className="mono muted">{result.mark}</p>
            <p className="help">This is the crew&apos;s own mark — share the blackbook with members, not the name.</p>
          </div>
        </div>

        <div className="panel panel--hazard">
          <p>
            <strong>{COPY.blackbook.warning}</strong>
          </p>
          <p className="muted" style={{ marginTop: 6 }}>
            The crew blackbook just downloaded. Anyone who holds it can post as the crew — hand it to members you trust,
            the same way you would hand a marker.
          </p>
        </div>

        {blackbookPayload ? (
          <>
            <p className="muted">Screenshot or print this as a second copy:</p>
            <QrBlock value={blackbookPayload} size={240} />
          </>
        ) : null}

        <div className="stack">
          <Link to={`/crew/${result.pubkey}`} className="btn btn--go btn--block sticker">
            See the crew page
          </Link>
          <button type="button" className="btn btn--ghost btn--block" onClick={() => navigate('/')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">{COPY.crew.label}</span>
        <h2 style={{ marginTop: 12 }}>{COPY.crew.action}</h2>
      </div>

      <div className="field">
        <label htmlFor="crew-name">Crew name</label>
        <input
          id="crew-name"
          className="input input--display"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 24))}
          placeholder="FASE"
        />
        <p className="help">Names are not unique — the crew&apos;s mark is what tells it apart.</p>
      </div>

      <div className="field">
        <label htmlFor="crew-pass">Blackbook passphrase (optional)</label>
        <input
          id="crew-pass"
          className="input"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Lock the crew blackbook"
        />
        <p className="help">Leave blank to make an unlocked blackbook. Members will need it to post as the crew.</p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button
        type="button"
        className="btn btn--go btn--block sticker"
        onClick={() => void run()}
        disabled={busy || stage !== null}
      >
        Start the crew
      </button>
    </div>
  );
}