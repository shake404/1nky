import { COPY, KINDS } from '@1nky/protocol';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Spraying } from '../components/Spraying.js';
import { ownPostIds } from '../lib/identity.js';
import { buffEvents, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * Retiring a name.
 *
 * Framed as a ritual rather than an error state, per the handoff: writers
 * retire names, that is normal, and the interface should treat it as a
 * deliberate act rather than an account deletion form.
 *
 * TODO (Phase 3): enumerate every event this tag ever signed via the read
 * API instead of only what this device remembers, so a retirement taken on a
 * second device still pulls everything down.
 */
export function HangItUp(): JSX.Element {
  const { tag, hangItUp } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [typed, setTyped] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);

  if (!tag) return <div className="shell empty" />;

  const matches = typed.trim().toLowerCase() === tag.name.trim().toLowerCase();

  const run = async (): Promise<void> => {
    setStage('spraying');
    try {
      const ids = await ownPostIds();
      if (ids.length > 0) {
        await buffEvents(tag, ids, [KINDS.FLICK, KINDS.COMMENT, KINDS.NOTE], { onStage: setStage });
      }
    } catch {
      // A wall we cannot reach must not trap someone in a name they are done
      // with. The local wipe happens either way.
      say('Some of it may still be up. The tag is done here.', 'hazard');
    }
    await hangItUp();
    setStage(null);
    say(COPY.hangItUp.done);
    navigate('/', { replace: true });
  };

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">last call</span>
        <h2 style={{ marginTop: 12 }}>{COPY.hangItUp.label}</h2>
      </div>

      <p style={{ fontSize: '1.05rem' }}>{COPY.hangItUp.blurb}</p>

      <div className="panel panel--hazard stack">
        <p>
          Everything you put up comes down. The name goes back on the shelf. Nobody —
          including you — gets it back.
        </p>
        <p className="muted">
          If you have a blackbook saved, that file stops meaning anything the moment this
          finishes.
        </p>
      </div>

      <div className="field">
        <label htmlFor="ritual">
          Type <strong className="hazard">{tag.name}</strong> to finish it
        </label>
        <input
          id="ritual"
          className="input input--display"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="TAG"
        />
      </div>

      <button
        type="button"
        className="btn btn--danger btn--block"
        onClick={() => void run()}
        disabled={!matches || stage !== null}
      >
        {COPY.hangItUp.confirm}
      </button>

      <Link to="/settings" className="btn btn--ghost btn--block">
        Not yet
      </Link>
    </div>
  );
}
