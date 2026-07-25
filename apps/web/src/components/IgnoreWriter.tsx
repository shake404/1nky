import { COPY } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import {
  ignoreWriter,
  ignoredReady,
  ignoredWriters,
  loadIgnored,
  stopIgnoring,
  subscribeIgnored,
} from '../lib/mute.js';
import type { Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * The ignored list, as a hook.
 *
 * The list lives on the device (see `mute.ts`); this subscribes so every open
 * screen redraws the moment it changes, wherever the change came from.
 */
export function useIgnoredWriters(): readonly string[] {
  const [list, setList] = useState<readonly string[]>(() => ignoredWriters());

  useEffect(() => {
    const off = subscribeIgnored(setList);
    if (ignoredReady()) setList(ignoredWriters());
    else void loadIgnored().then(setList);
    return off;
  }, []);

  return list;
}

interface Props {
  pubkey: string;
  /** Lets the host screen show its own "spraying..." wait. */
  onStage?: (stage: Stage | null) => void;
  /** Called once the change has gone up — lets a screen navigate away. */
  onDone?: (ignored: boolean) => void;
  /** `quiet` is the small inline control; `button` is a full-width action. */
  look?: 'quiet' | 'button';
}

/**
 * "Ignore this writer" / "Stop ignoring".
 *
 * Never framed as punishment — it is a preference about your own wall, and it
 * is reversible in one tap from the same spot.
 */
export function IgnoreWriter({ pubkey, onStage, onDone, look = 'quiet' }: Props): JSX.Element | null {
  const { tag } = useTag();
  const { say } = useToast();
  const list = useIgnoredWriters();
  const [busy, setBusy] = useState(false);

  // Your own wall is not something you can hide from yourself.
  if (!tag || tag.pubkey.toLowerCase() === pubkey.toLowerCase()) return null;

  const ignored = list.includes(pubkey.toLowerCase());

  const toggle = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    onStage?.('spraying');
    try {
      if (ignored) {
        await stopIgnoring(tag, pubkey, { ...(onStage ? { onStage } : {}) });
        say('Back on your wall.');
      } else {
        await ignoreWriter(tag, pubkey, { ...(onStage ? { onStage } : {}) });
        say(COPY.ignoreWriter.done);
      }
      onDone?.(!ignored);
    } catch {
      // The device list already changed — only the copy that travels between
      // devices did not. Say exactly that, in the interface's voice.
      say('Done here, but it did not go up. It will not carry to your other device yet.', 'hazard');
      onDone?.(!ignored);
    } finally {
      setBusy(false);
      onStage?.(null);
    }
  };

  const label = ignored ? COPY.ignoreWriter.undo : COPY.ignoreWriter.label;

  if (look === 'button') {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm sticker"
        onClick={() => void toggle()}
        disabled={busy}
      >
        {label}
      </button>
    );
  }

  return (
    <button type="button" className="flagit__open mono" onClick={() => void toggle()} disabled={busy}>
      {label}
    </button>
  );
}
