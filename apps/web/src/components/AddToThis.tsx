import { COPY, type EventRef } from '@1nky/protocol';
import { useMemo, useState } from 'react';
import { parseWalls } from '../lib/amend.js';
import type { Tag } from '../lib/identity.js';
import { extractMentions, type MentionCandidate } from '../lib/mentions.js';
import { amendPost, type Stage } from '../lib/publish.js';
import { MentionBox } from './MentionBox.js';

interface Props {
  /** The post being added to. */
  target: EventRef;
  /**
   * The key that PUT IT UP — your own tag, or the crew's when the crew put it
   * up. Not whoever happens to be on screen: the wall only honours an addition
   * from the writer whose post it is.
   */
  owner: Tag;
  /** True when the owner is a crew key rather than this device's own tag. */
  asCrew?: boolean;
  /** Walls it is already on, so they are neither shown twice nor sent twice. */
  boards: readonly string[];
  /** Writers you can name — the people already on this page. */
  candidates: readonly MentionCandidate[];
  onStage: (stage: Stage | null) => void;
  /** Called with what actually went up, so the screen can show it immediately. */
  onAdded: (added: { boards: string[]; mentions: string[] }) => void;
  onError: (message: string) => void;
}

/**
 * "Add to this" — walls and writers, put on a post that is already up.
 *
 * Not an edit, and deliberately does not read like one. Nothing that went up
 * changes: this puts a second small thing up beside it, and the wall shows the
 * two together. Which is why there is no way to take a wall off here — what has
 * been said stays said, and the way to undo a post is still to buff it.
 *
 * The @-box is the same one the reply box uses, so naming somebody here reaches
 * them exactly as naming them in a reply does.
 */
export function AddToThis({
  target,
  owner,
  asCrew = false,
  boards,
  candidates,
  onStage,
  onAdded,
  onError,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [walls, setWalls] = useState('');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);

  const newBoards = useMemo(() => parseWalls(walls, boards), [walls, boards]);
  const newMentions = useMemo(
    // The owner is never named: it is their own post, and the wall drops a
    // writer naming themselves anyway.
    () => extractMentions(who, candidates).filter((pubkey) => pubkey !== target.pubkey),
    [who, candidates, target.pubkey],
  );

  const nothingToAdd = newBoards.length === 0 && newMentions.length === 0;

  const put = async (): Promise<void> => {
    if (nothingToAdd || busy) return;
    setBusy(true);
    onStage('spraying');
    try {
      await amendPost(owner, target, {
        ...(newBoards.length ? { boards: newBoards } : {}),
        ...(newMentions.length ? { mentions: newMentions } : {}),
        // A crew's post is not this device's own, exactly as when putting one up.
        recordOwn: !asCrew,
        onStage,
      });
      onAdded({ boards: newBoards, mentions: newMentions });
      setWalls('');
      setWho('');
      setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'That did not go up.');
    } finally {
      setBusy(false);
      onStage(null);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        {COPY.addTo.label}
      </button>
    );
  }

  return (
    <div className="panel stack">
      <p className="help">{COPY.addTo.blurb}</p>

      <div className="field">
        <label htmlFor="add-walls">Walls</label>
        <input
          id="add-walls"
          className="input"
          value={walls}
          onChange={(event) => setWalls(event.target.value)}
          placeholder="oakland, west oakland"
          maxLength={200}
          autoComplete="off"
        />
        <p className="help">Where it is. Commas between them.</p>
      </div>

      <div className="field">
        <label htmlFor="add-writers">Writers</label>
        <MentionBox
          id="add-writers"
          value={who}
          onChange={setWho}
          candidates={candidates}
          maxLength={300}
          placeholder="@"
        />
        <p className="help">Type @ to name whoever else is on it.</p>
      </div>

      {newBoards.length > 0 ? (
        <p className="mono faint">
          adding {newBoards.map((slug) => `#${slug}`).join(' ')}
        </p>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="btn btn--go btn--sm sticker"
          onClick={() => void put()}
          disabled={nothingToAdd || busy}
        >
          Put it up
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setOpen(false);
            setWalls('');
            setWho('');
          }}
        >
          Leave it
        </button>
      </div>
    </div>
  );
}
