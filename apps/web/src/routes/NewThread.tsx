import { beefExpiration, COPY, normalizeBoard, type BeefDuration } from '@1nky/protocol';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Spraying } from '../components/Spraying.js';
import { postThread, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const SUBJECT_MAX = 80;
const BODY_MAX = 2000;

/**
 * How long it runs, in the writer's words.
 *
 * The four choices are the whole vocabulary — there is no date picker, because
 * beef is not scheduled. "pinned" is the one that never comes down; everything
 * else is on a timer from the moment it goes up.
 */
const CHOICES: readonly { value: BeefDuration; label: string; note: string }[] = [
  { value: '24h', label: '24 hours', note: 'gone tomorrow' },
  { value: '72h', label: '3 days', note: 'a weekend of it' },
  { value: '7d', label: 'a week', note: 'settle it properly' },
  { value: 'pinned', label: 'pinned', note: 'stays up' },
];

/** `/b/:slug/new` — start a thread on a board. */
export function NewThread(): JSX.Element {
  const { slug = '' } = useParams();
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [duration, setDuration] = useState<BeefDuration>('24h');
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  const board = normalizeBoard(slug);

  const submit = async (): Promise<void> => {
    if (!tag || !body.trim() || stage) return;
    setError('');
    setStage('spraying');
    try {
      const expiration = beefExpiration(duration);
      const event = await postThread(tag, {
        content: body,
        boards: [board],
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        // `pinned` hands back null — no lifetime goes on it at all.
        ...(expiration === null ? {} : { expiration }),
        onStage: setStage,
      });
      say('Up.');
      // `fresh` tells the thread page this was published a heartbeat ago, so
      // it waits out the wall's filing delay instead of calling it gone.
      navigate(`/t/${event.id}`, { replace: true, state: { fresh: true } });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go up. Try again.');
      setStage(null);
    }
  };

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <Link to={`/b/${board}`} className="tape">
          {board}
        </Link>
        <h2 style={{ marginTop: 12 }}>Start one</h2>
      </div>

      <div className="field">
        <label htmlFor="thread-subject">Title</label>
        <input
          id="thread-subject"
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value.slice(0, SUBJECT_MAX))}
          placeholder="Optional"
        />
        <p className="help">
          {SUBJECT_MAX - subject.length} left. Skip it and the first line does the job.
        </p>
      </div>

      <div className="field">
        <label htmlFor="thread-body">What&apos;s the word</label>
        <textarea
          id="thread-body"
          className="textarea"
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
          placeholder="Say it."
          style={{ minHeight: 200 }}
        />
        <p className="help">{BODY_MAX - body.length} left.</p>
      </div>

      <section className="stack">
        <h3>How long till it dies?</h3>
        <p className="help">{COPY.beef.blurb}</p>
        <div className="beef-pick">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={`beef-pick__option sticker ${duration === choice.value ? 'beef-pick__option--on' : ''}`}
              aria-pressed={duration === choice.value}
              onClick={() => setDuration(choice.value)}
            >
              <span className="beef-pick__label">{choice.label}</span>
              <span className="beef-pick__note mono">{choice.note}</span>
            </button>
          ))}
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <button
        type="button"
        className="btn btn--go btn--block sticker"
        onClick={() => void submit()}
        disabled={!body.trim() || stage !== null}
      >
        Put it up
      </button>
    </div>
  );
}
