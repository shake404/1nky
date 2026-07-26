import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WriterChip } from '../components/WriterChip.js';
import { ago } from '../lib/platform.js';
import {
  fetchShouts,
  loadShoutsSeen,
  markShoutsSeen,
  placeText,
  shoutLink,
  type Shout,
} from '../lib/shoutouts.js';
import { useTag } from '../state/TagProvider.js';

/**
 * `/mentions` — Shout-outs: the times somebody said your name.
 *
 * Not a reply inbox. A reply already reaches you; this is the other thing, the
 * one where two writers are talking and one of them brings you up. Every row is
 * a door into that conversation, because the only useful thing to do with
 * "somebody said your name" is go and read what they said.
 *
 * "New" is worked out from a stamp this device keeps of the last time this
 * screen was opened — snapshotted on arrival, so walking in does not instantly
 * un-highlight everything you came to look at, and written back once the page
 * has actually landed.
 */
export function Shoutouts(): JSX.Element {
  const { tag } = useTag();
  const [shouts, setShouts] = useState<Shout[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The stamp as it was when this screen opened. Frozen for the whole visit so
  // the "new" marks stay put while it is being read.
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const marked = useRef(false);

  const pubkey = tag?.pubkey ?? '';

  useEffect(() => {
    let live = true;
    void loadShoutsSeen().then((at) => {
      if (live) setSeenAt(at);
    });
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(
    async (from: string | null, alive: () => boolean = () => true): Promise<void> => {
      if (!pubkey) return;
      setLoading(true);
      try {
        const page = await fetchShouts(pubkey, { cursor: from });
        if (!alive()) return;
        setShouts((current) => {
          const merged = from ? [...current, ...page.shouts] : page.shouts;
          const seen = new Set<string>();
          return merged.filter((s) => !seen.has(s.id) && seen.add(s.id));
        });
        setCursor(page.cursor);
        setFailed(false);
        // Only once the first page is really here: a read that never landed has
        // not been looked at, and marking it seen would lose the badge for good.
        if (!from && !marked.current) {
          marked.current = true;
          const newest = page.shouts[0]?.createdAt ?? 0;
          void markShoutsSeen(Math.max(newest, Math.floor(Date.now() / 1000)));
        }
      } catch {
        if (alive()) setFailed(true);
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [pubkey],
  );

  useEffect(() => {
    let live = true;
    setShouts([]);
    setCursor(null);
    void load(null, () => live);
    return () => {
      live = false;
    };
  }, [load]);

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">your name came up</span>
        <h2 style={{ marginTop: 12 }}>Shout-outs</h2>
        <p className="help" style={{ marginTop: 10 }}>
          When somebody puts your name in what they write, it lands here. Plain replies to your
          own stuff do not — those are already under the thing you put up.
        </p>
      </div>

      <hr className="rule" />

      {shouts.length === 0 && !loading ? (
        <div className="empty">
          <h2>Nobody has said your name yet.</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            Get out on the boards. It comes with being around.
          </p>
          <Link to="/boards" className="btn btn--go sticker">
            Go look
          </Link>
          {failed ? (
            <p className="help" style={{ marginTop: 20 }}>
              Could not reach the wall.
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="list-reset dm-list">
          {shouts.map((shout) => (
            <li key={shout.id}>
              <ShoutRow shout={shout} fresh={seenAt !== null && shout.createdAt > seenAt} />
            </li>
          ))}
        </ul>
      )}

      {loading ? (
        <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
          loading
        </p>
      ) : null}

      {cursor && !loading ? (
        <button type="button" className="btn btn--ghost btn--block" onClick={() => void load(cursor)}>
          More
        </button>
      ) : null}
    </div>
  );
}

/** One row: who said it, what they said, and where to go and read it. */
export function ShoutRow({ shout, fresh }: { shout: Shout; fresh: boolean }): JSX.Element {
  const where = placeText(shout.where);
  const kind = shout.where.type === 'thread' ? 'under' : 'on';

  return (
    <Link to={shoutLink(shout.where)} className={`shout${fresh ? ' shout--new' : ''}`}>
      <div className="shout__top">
        <WriterChip
          pubkey={shout.writer.pubkey}
          name={shout.writer.tag ?? undefined}
          avatarSha256={shout.writer.avatarSha256}
          size={22}
          linked={false}
        />
        <span className="mono faint">{ago(shout.createdAt)}</span>
      </div>

      <p className="shout__said">{shout.content}</p>

      <span className="mono faint shout__where">
        {kind} {where}
      </span>
      {fresh ? <span className="dm-dot shout__dot" aria-label="new" /> : null}
    </Link>
  );
}
