import { fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { ago } from '../lib/platform.js';
import { fetchProfile, type ProfileMeta } from '../lib/profiles.js';
import { useDms } from '../state/DmProvider.js';
import { useTag } from '../state/TagProvider.js';

/** `/messages` — the inbox. One row per writer you have a thread with. */
export function Messages(): JSX.Element {
  const { conversations, ready } = useDms();
  const { tag } = useTag();
  const [names, setNames] = useState<Record<string, ProfileMeta | null>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      const entries = await Promise.all(
        conversations.map(async (c) => [c.partner, await fetchProfile(c.partner)] as const),
      );
      if (!live) return;
      setNames(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, [conversations]);

  if (!tag) return <div className="shell empty" />;

  if (ready && conversations.length === 0) {
    return (
      <div className="shell pad stack stack--wide">
        <div>
          <span className="tape">inbox</span>
          <h2 style={{ marginTop: 12 }}>Word</h2>
        </div>
        <div className="empty">
          <h2>No word yet.</h2>
          <p className="muted">Start something.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">inbox</span>
        <h2 style={{ marginTop: 12 }}>Word</h2>
      </div>

      <ul className="list-reset dm-list">
        {conversations.map((c) => {
          const meta = names[c.partner];
          const name = meta?.name?.trim() || 'unnamed';
          return (
            <li key={c.partner}>
              <Link
                to={`/messages/${c.partner}`}
                className={`dm-row${c.unread ? ' dm-row--unread' : ''}`}
              >
                <Identicon pubkey={c.partner} size={40} />
                <span className="dm-row__main">
                  <span className="row spread">
                    <span className="writer__name">{name}</span>
                    <span className="mono faint">{ago(c.lastCreatedAt)}</span>
                  </span>
                  <span className="dm-row__preview">{c.lastText}</span>
                  <span className="writer__mark" title="same name, different mark = different writer">
                    {fingerprint(c.partner)}
                  </span>
                </span>
                {c.unread ? <span className="dm-dot" aria-label="unread" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
