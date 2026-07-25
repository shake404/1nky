import { beefExpiration, COPY, normalizeBoard, type BeefDuration } from '@1nky/protocol';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { postThread, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';
import { Spraying } from './Spraying.js';

const SUBJECT_MAX = 80;
const BODY_MAX = 2000;

/**
 * How long it runs, in the writer's words.
 *
 * The four choices are the whole vocabulary — there is no date picker, because
 * beef is not scheduled. "pinned" is the one that never comes down; everything
 * else is on a timer from the moment it goes up.
 */
export const BEEF_CHOICES: readonly { value: BeefDuration; label: string; note: string }[] = [
  { value: '24h', label: '24 hours', note: 'gone tomorrow' },
  { value: '72h', label: '3 days', note: 'a weekend of it' },
  { value: '7d', label: 'a week', note: 'settle it properly' },
  { value: 'pinned', label: 'pinned', note: 'stays up' },
];

export interface ThreadComposeProps {
  /** Board this lands on. Slugified here, so a messy one is fine. */
  board: string;
  /**
   * Which lifetime is picked when the form opens. Every board but one starts on
   * a day; a board where things are meant to stay put starts on `pinned` — the
   * four choices are still all there either way.
   */
  defaultDuration?: BeefDuration;
  /** Label over the body field. */
  bodyLabel?: string;
  bodyPlaceholder?: string;
  submitLabel?: string;
  /** What the toast says once it is up. */
  postedLabel?: string;
}

/**
 * The one place a thread gets written.
 *
 * Both the board's "start one" screen and /holler mount this, so the lifetime
 * selector, the caps, the work and the landing behaviour only exist once.
 */
export function ThreadCompose({
  board: rawBoard,
  defaultDuration = '24h',
  bodyLabel = "What's the word",
  bodyPlaceholder = 'Say it.',
  submitLabel = 'Put it up',
  postedLabel = 'Up.',
}: ThreadComposeProps): JSX.Element | null {
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [duration, setDuration] = useState<BeefDuration>(defaultDuration);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  const board = normalizeBoard(rawBoard);

  if (!tag) return null;

  const submit = async (): Promise<void> => {
    if (!body.trim() || stage) return;
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
      say(postedLabel);
      // `fresh` tells the thread page this was published a heartbeat ago, so
      // it waits out the wall's filing delay instead of calling it gone.
      navigate(`/t/${event.id}`, { replace: true, state: { fresh: true } });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go up. Try again.');
      setStage(null);
    }
  };

  return (
    <>
      {stage ? <Spraying stage={stage} /> : null}

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
        <label htmlFor="thread-body">{bodyLabel}</label>
        <textarea
          id="thread-body"
          className="textarea"
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
          placeholder={bodyPlaceholder}
          style={{ minHeight: 200 }}
        />
        <p className="help">{BODY_MAX - body.length} left.</p>
      </div>

      <section className="stack">
        <h3>How long till it dies?</h3>
        <p className="help">{COPY.beef.blurb}</p>
        <div className="beef-pick">
          {BEEF_CHOICES.map((choice) => (
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
        {submitLabel}
      </button>
    </>
  );
}
