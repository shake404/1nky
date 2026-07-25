import { COPY } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { loadMintedPutOns, mintPutOn, putOnLink, type MintedPutOn } from '../lib/invites.js';
import { ago, copyText } from '../lib/platform.js';
import type { Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';
import { Spraying } from './Spraying.js';

/** "Made 3h ago." — without the "just now ago" that `ago()` alone would give. */
function madeWhen(createdAt: number): string {
  const when = ago(createdAt);
  return when === 'just now' ? 'Just made.' : `Made ${when} ago.`;
}

/**
 * "Put someone on" — the Setup section for vouching for one writer.
 *
 * Pressing the button puts up a signed thing only this tag could have made, and
 * hands back one string. That string is worth exactly one writer: whoever holds
 * it skips the newcomer's wait on their first post, and the wall remembers who
 * vouched for them. Nothing about the person it goes to is stored here — the
 * local list is only so a string can be shown again after a reload.
 */
export function PutSomeoneOn(): JSX.Element | null {
  const { tag } = useTag();
  const { say } = useToast();
  const [minted, setMinted] = useState<MintedPutOn[]>([]);
  const [latest, setLatest] = useState<MintedPutOn | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    void loadMintedPutOns().then((rows) => {
      if (live) setMinted(rows);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!tag) return null;

  const run = async (): Promise<void> => {
    setBusy(true);
    setStage('spraying');
    try {
      const entry = await mintPutOn(tag, { onStage: setStage });
      setLatest(entry);
      setMinted(await loadMintedPutOns());
      say('Made one. Hand it to one writer.');
    } catch (problem) {
      say(problem instanceof Error ? problem.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
      setBusy(false);
    }
  };

  const copy = async (value: string, what: string): Promise<void> => {
    const ok = await copyText(value);
    say(ok ? `${what} copied.` : 'Could not copy it — select it and copy by hand.', ok ? 'plain' : 'hazard');
  };

  const shown = latest ?? minted[0] ?? null;
  const rest = showAll ? minted.filter((row) => row.code !== shown?.code) : [];

  return (
    <section className="stack">
      {stage ? <Spraying stage={stage} /> : null}

      <h3>{COPY.putOn.action}</h3>
      <p className="help">
        Hand this to one writer. It marks them as put on — they skip the line.
      </p>

      {shown ? (
        <div className="panel stack" style={{ gap: 10 }}>
          <span className="kicker">the put-on</span>
          <p className="mono" style={{ wordBreak: 'break-all', fontSize: '0.72rem' }}>
            {shown.code}
          </p>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm sticker"
              onClick={() => void copy(shown.code, 'Put-on')}
            >
              Copy it
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm sticker"
              onClick={() => void copy(putOnLink(shown.code), 'Link')}
            >
              Copy the link
            </button>
          </div>
          <p className="mono faint" style={{ wordBreak: 'break-all', fontSize: '0.68rem' }}>
            {putOnLink(shown.code)}
          </p>
          <p className="help">{madeWhen(shown.createdAt)} Only good for one writer.</p>
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn--go btn--sm sticker"
        onClick={() => void run()}
        disabled={busy || stage !== null}
      >
        {busy ? 'Making it...' : COPY.putOn.action}
      </button>

      {minted.length > 1 ? (
        <>
          <button
            type="button"
            className="kicker"
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              textDecoration: 'underline',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? 'Hide the older ones' : `Older ones (${minted.length - 1})`}
          </button>
          {showAll ? (
            <ul className="list-reset stack" style={{ gap: 10 }}>
              {rest.map((row) => (
                <li key={row.code} className="settings-row">
                  <span className="mono faint" style={{ wordBreak: 'break-all', fontSize: '0.68rem' }}>
                    {row.code}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void copy(row.code, 'Put-on')}
                  >
                    Copy
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <p className="help">
        Whoever you put on is on you. Their work comes back to your tag, so pick like it matters.
      </p>
    </section>
  );
}
