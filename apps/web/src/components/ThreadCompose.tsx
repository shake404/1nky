import { beefExpiration, COPY, normalizeBoard, type BeefDuration } from '@1nky/protocol';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HAPPENING_CLEARS_COPY, whenText } from '../lib/happenings.js';
import { postThread, type Stage } from '../lib/publish.js';
import { useActiveTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';
import { Spraying } from './Spraying.js';

const SUBJECT_MAX = 80;
const BODY_MAX = 2000;

/**
 * Turn what the browser's date-and-time field gives us into unix seconds.
 *
 * The field hands back a bare `2026-08-01T20:00` with no zone on it, which the
 * platform reads as the writer's own clock — which is the right reading: a jam
 * at eight is at eight where the jam is.
 *
 * Returns null for empty or unreadable input so the caller can just refuse.
 */
export function happeningSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed).getTime();
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.floor(parsed / 1000);
  return seconds > 0 ? seconds : null;
}

/** What the date field's `min` should be: right now, in the field's format. */
export function dateFieldFloor(now: number = Date.now()): string {
  const at = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

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
  /**
   * Open with the date switch already flipped. Used by the "put one up" door on
   * the happenings list, so somebody who came to post a jam does not have to
   * find the switch first.
   */
  defaultHappening?: boolean;
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
  defaultHappening = false,
}: ThreadComposeProps): JSX.Element | null {
  // Threads are signed by the ACTIVE identity (own tag, or a crew when the
  // switcher is on). Gating on `active` keeps a crew thread off the me store.
  const { active, actingAsCrew } = useActiveTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [duration, setDuration] = useState<BeefDuration>(defaultDuration);
  const [happening, setHappening] = useState(defaultHappening);
  const [goesDown, setGoesDown] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  const board = normalizeBoard(rawBoard);
  const happeningAt = happening ? happeningSeconds(goesDown) : null;

  if (!active) return null;

  const submit = async (): Promise<void> => {
    if (!body.trim() || stage) return;
    setError('');

    if (happening) {
      if (happeningAt === null) {
        setError('Say when it goes down.');
        return;
      }
      if (happeningAt < Math.floor(Date.now() / 1000)) {
        setError('That is already past.');
        return;
      }
    }

    setStage('spraying');
    try {
      const expiration = beefExpiration(duration);
      const event = await postThread(active, {
        content: body,
        boards: [board],
        recordOwn: actingAsCrew === null,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        // A date of its own comes with its own clock: the wall clears it a week
        // after it goes down, so the lifetime picker steps out of the way.
        ...(happeningAt !== null
          ? { happeningAt }
          : // `pinned` hands back null — no lifetime goes on it at all.
            expiration === null
            ? {}
            : { expiration }),
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
        <label className={`toggle ${happening ? 'toggle--on' : ''}`}>
          <span className="toggle__box" aria-hidden="true" />
          <input
            type="checkbox"
            className="sr-only"
            checked={happening}
            onChange={(e) => setHappening(e.target.checked)}
          />
          It&apos;s a happening
        </label>
        <p className="help">A jam, a meet, a show — something with a date on it.</p>

        {happening ? (
          <div className="field">
            <label htmlFor="thread-when">When does it go down</label>
            <input
              id="thread-when"
              className="input"
              type="datetime-local"
              value={goesDown}
              min={dateFieldFloor()}
              onChange={(e) => setGoesDown(e.target.value)}
            />
            <p className="help">
              {happeningAt === null
                ? `It goes on the list of what is coming, and ${HAPPENING_CLEARS_COPY}.`
                : `Goes down ${whenText(happeningAt)}, and ${HAPPENING_CLEARS_COPY}.`}
            </p>
          </div>
        ) : null}
      </section>

      {happening ? null : (
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
      )}

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
