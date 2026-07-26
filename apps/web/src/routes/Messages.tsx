import { fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { Identicon } from '../components/Identicon.js';
import { lookupTarget, type LookupOutcome } from '../lib/lookup.js';
import { ago } from '../lib/platform.js';
import { fetchProfile, type ProfileMeta } from '../lib/profiles.js';
import { useDms } from '../state/DmProvider.js';
import { useTag } from '../state/TagProvider.js';

/** `/messages` — the inbox. One row per writer you have a thread with. */
export function Messages(): JSX.Element {
  const { conversations, ready } = useDms();
  const { tag } = useTag();
  const [names, setNames] = useState<Record<string, ProfileMeta | null>>({});
  const [starting, setStarting] = useState(false);

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
        {starting ? (
          <StartConversation onClose={() => setStarting(false)} />
        ) : (
          <div className="empty">
            <h2>No word yet.</h2>
            <p className="muted">Start something.</p>
            <button
              type="button"
              className="btn btn--go btn--sm sticker"
              style={{ marginTop: 10 }}
              onClick={() => setStarting(true)}
            >
              Send word
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      <div className="row spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <span className="tape">inbox</span>
          <h2 style={{ marginTop: 12 }}>Word</h2>
        </div>
        {!starting ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStarting(true)}>
            Send word
          </button>
        ) : null}
      </div>

      {starting ? <StartConversation onClose={() => setStarting(false)} /> : null}

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

// ---------------------------------------------------------------------------
// Start a conversation from Word — paste a writer's or crew's link, look them
// up, tap the row to open the thread. Same lookup the crew founder panel
// uses to put someone on (see lib/lookup.ts), same writer-row markup as
// everywhere else in the app.
// ---------------------------------------------------------------------------

type LookupState = { phase: 'idle' } | { phase: 'looking-up' } | { phase: 'done'; outcome: LookupOutcome };

function StartConversation({ onClose }: { onClose: () => void }): JSX.Element {
  const [input, setInput] = useState('');
  const [state, setState] = useState<LookupState>({ phase: 'idle' });

  const busy = state.phase === 'looking-up';

  const doLookup = async (): Promise<void> => {
    if (!input.trim() || busy) return;
    setState({ phase: 'looking-up' });
    const outcome = await lookupTarget(input);
    setState({ phase: 'done', outcome });
  };

  return (
    <div className="panel">
      <p className="help" style={{ marginTop: 0 }}>
        Paste a writer&apos;s or crew&apos;s link or tag id to send them word.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setState({ phase: 'idle' });
          }}
          placeholder="https://1nky.com/w/…  or  /w/…  or tag id"
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void doLookup()}
          disabled={busy || !input.trim()}
        >
          Look up
        </button>
      </div>

      {busy ? <p className="help">Looking...</p> : null}

      {state.phase === 'done' && state.outcome.status === 'invalid' ? (
        <p className="error" style={{ marginTop: 4 }}>
          That is not a writer or crew. Paste their link or tag id.
        </p>
      ) : null}

      {state.phase === 'done' && state.outcome.status === 'not-found' ? (
        <p className="error" style={{ marginTop: 4 }}>
          Nobody there yet.
        </p>
      ) : null}

      {state.phase === 'done' && state.outcome.status === 'found' ? (
        <Link
          to={`/messages/${state.outcome.pubkey}`}
          className="writer"
          style={{ marginTop: 8 }}
        >
          <Avatar
            pubkey={state.outcome.pubkey}
            avatarSha256={state.outcome.avatarSha256}
            size={32}
            alt={state.outcome.name || ''}
          />
          <span className="writer__name">{state.outcome.name || 'unnamed'}</span>
          <span className="writer__mark">{state.outcome.mark}</span>
        </Link>
      ) : null}

      <button
        type="button"
        className="btn btn--ghost btn--sm"
        style={{ marginTop: 10 }}
        onClick={onClose}
        disabled={busy}
      >
        Never mind
      </button>
    </div>
  );
}
