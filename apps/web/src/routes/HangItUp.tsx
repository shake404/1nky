import { COPY } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCrewKeys } from '../lib/crew-keys.js';
import type { Stage } from '../lib/publish.js';
import {
  buffEverything,
  clearPendingRetirement,
  collectOwnIds,
  markRetired,
  pendingRetirement,
  type RitualProgress,
} from '../lib/retire.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * Retiring a name.
 *
 * A ritual, not an account-deletion form: writers retire names, that is normal,
 * and the interface treats it as a deliberate act with a known shape. The three
 * steps are stated up front, in order, before anything is armed — nobody should
 * discover what this does by doing it.
 *
 * The work itself lives in `lib/retire.ts`. What this screen owns is the
 * ceremony: the three steps, the typed name, the tally while the work comes
 * down, and the offer to finish a job that got interrupted.
 */

/** Said plainly, up front, in the order it happens. */
const STEPS: readonly string[] = [
  'Everything you put up gets buffed. Flicks, clips, threads, replies — all of it comes down.',
  'Your name gets marked retired, so anybody who looks it up later reads that you hung it up.',
  'This device forgets your tag. Nothing brings it back. Not you, not us.',
];

type Phase = 'counting' | 'buffing' | 'marking';

export function HangItUp(): JSX.Element {
  const { tag, hangItUp } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [progress, setProgress] = useState<RitualProgress | null>(null);
  const [error, setError] = useState('');
  /** Leftovers from an attempt that did not finish. Null when none did. */
  const [pending, setPending] = useState<string[] | null>(null);
  const [crews, setCrews] = useState(0);

  const pubkey = tag?.pubkey ?? '';

  // Two reads on the way in: whether this tag left a job unfinished, and how
  // many crews this device is holding — because the screen has to say out loud
  // that they are not part of this.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [left, keyring] = await Promise.all([
        pendingRetirement(pubkey).catch(() => null),
        listCrewKeys().catch(() => []),
      ]);
      if (!live) return;
      setPending(left);
      setCrews(keyring.length);
    })();
    return () => {
      live = false;
    };
  }, [pubkey]);

  if (!tag) return <div className="shell empty" />;

  const running = phase !== null;
  const matches = typed.trim().toLowerCase() === tag.name.trim().toLowerCase();

  /** Take the listed work down, mark the name, then wipe the device. */
  const finish = async (ids: readonly string[]): Promise<void> => {
    setError('');
    try {
      setPhase('buffing');
      await buffEverything(tag, ids, { onProgress: setProgress, onStage: setStage });
      setPhase('marking');
      await markRetired(tag, { onStage: setStage });
    } catch {
      // A refusal mid-ritual must not strand somebody half-retired with no way
      // back in: the leftovers stay on the device and the tag stays usable, so
      // re-opening this screen offers to finish the job.
      setPhase(null);
      setStage(null);
      setPending(await pendingRetirement(tag.pubkey).catch(() => ids as string[]));
      setError('That did not all go through. Your tag still works — come back and finish the job.');
      say('Not done. Some of it is still up.', 'hazard');
      return;
    }

    await clearPendingRetirement();
    await hangItUp();
    setPhase(null);
    setStage(null);
    say("It's done. Respect.");
    navigate('/', { replace: true });
  };

  const begin = async (): Promise<void> => {
    if (!matches || running) return;
    setError('');
    setPhase('counting');
    setProgress(null);
    const ids = await collectOwnIds(tag.pubkey);
    await finish(ids);
  };

  const headline =
    phase === 'counting'
      ? 'Counting what you put up...'
      : phase === 'marking'
        ? 'Marking the name retired...'
        : progress === null
          ? 'Buffing what you put up...'
          : progress.total === 0
            ? 'Nothing left to buff'
            : `Buffing ${progress.done} of ${progress.total}`;

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">last call</span>
        <h2 style={{ marginTop: 12 }}>{COPY.hangItUp.label}</h2>
      </div>

      <p style={{ fontSize: '1.05rem' }}>{COPY.hangItUp.blurb}</p>

      <section className="stack">
        <h3>How it goes</h3>
        <ol className="list-reset stack ritual-steps">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <div className="panel panel--hazard stack">
        <p>
          The name goes back on the shelf. Nobody — including you — gets it back.
        </p>
        <p className="muted">
          If you have a blackbook saved, that file stops meaning anything the moment this
          finishes.
        </p>
        <p className="muted">
          Crews you hold stay in your book. Hand them off or burn them separately.
          {crews > 0 ? ` This device is holding ${crews} of them.` : ''}
        </p>
        {crews > 0 ? (
          <Link to="/crews" className="btn btn--ghost btn--sm sticker">
            Sort your crews out first
          </Link>
        ) : null}
      </div>

      {running ? (
        <div className="panel panel--hazard stack" role="status" aria-live="polite">
          <p className="display" style={{ fontSize: '1.4rem' }}>
            {headline}
          </p>
          <div className="tally">
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="kicker">
            {stage === 'posting' ? 'putting it up...' : COPY.spraying.label} — keep this open
          </p>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      {pending !== null && !running ? (
        <div className="panel stack">
          <h3>You started this already</h3>
          <p className="muted">
            {pending.length === 0
              ? 'Everything came down. The name still has to be marked, and this device still has your tag on it.'
              : `${pending.length} ${pending.length === 1 ? 'thing is' : 'things are'} still up.`}
          </p>
          <button
            type="button"
            className="btn btn--danger btn--block"
            onClick={() => void finish(pending)}
          >
            Finish the job
          </button>
        </div>
      ) : (
        <>
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
              disabled={running}
            />
          </div>

          <button
            type="button"
            className="btn btn--danger btn--block"
            onClick={() => void begin()}
            disabled={!matches || running}
          >
            {COPY.hangItUp.confirm}
          </button>
        </>
      )}

      <Link to="/settings" className="btn btn--ghost btn--block">
        Not yet
      </Link>
    </div>
  );
}
