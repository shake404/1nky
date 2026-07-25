import { COPY } from '@1nky/protocol';
import { useState } from 'react';
import { FLAG_CHOICES, FLAG_NOTE_MAX, flagIt, type FlagTarget } from '../lib/flag.js';
import type { Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

interface Props {
  target: FlagTarget;
  /** Lets the host screen show its own "spraying..." wait. */
  onStage?: (stage: Stage | null) => void;
}

/**
 * "Flag it" — small, out of the way, and one tap from a reason.
 *
 * Deliberately quiet: a flag is not a feature to show off, and a loud control
 * invites use as a weapon. It sits below the post, in the interface's ordinary
 * voice, and the reasons read like a writer talking.
 */
export function FlagIt({ target, onStage }: Props): JSX.Element | null {
  const { tag } = useTag();
  const { say } = useToast();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!tag) return null;

  const close = (): void => {
    setOpen(false);
    setPicked(null);
    setNote('');
  };

  const send = async (): Promise<void> => {
    const choice = FLAG_CHOICES.find((c) => c.reason === picked);
    if (!choice || busy) return;
    setBusy(true);
    onStage?.('spraying');
    try {
      await flagIt(tag, target, choice.reason, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(onStage ? { onStage } : {}),
      });
      close();
      say('Flagged. A mod will look at it.');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setBusy(false);
      onStage?.(null);
    }
  };

  if (!open) {
    return (
      <button type="button" className="flagit__open mono" onClick={() => setOpen(true)}>
        {COPY.flagIt.label}
      </button>
    );
  }

  return (
    <div className="panel stack flagit">
      <p className="kicker">{COPY.flagIt.prompt}</p>

      <div className="chips">
        {FLAG_CHOICES.map((choice) => (
          <button
            key={choice.reason}
            type="button"
            className={`chip${picked === choice.reason ? ' chip--active' : ''}`}
            aria-pressed={picked === choice.reason}
            onClick={() => setPicked(choice.reason)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="flag-note">Anything else (optional)</label>
        <input
          id="flag-note"
          className="input"
          value={note}
          maxLength={FLAG_NOTE_MAX}
          onChange={(event) => setNote(event.target.value.slice(0, FLAG_NOTE_MAX))}
          placeholder="one line"
        />
      </div>

      <div className="row">
        <button
          type="button"
          className="btn btn--go btn--sm sticker"
          disabled={!picked || busy}
          onClick={() => void send()}
        >
          Send it
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={close} disabled={busy}>
          Never mind
        </button>
      </div>
    </div>
  );
}
