import { DM_TEXT_MAX, fingerprint } from '@1nky/protocol';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { Spraying } from '../components/Spraying.js';
import { ago } from '../lib/platform.js';
import { fetchProfile } from '../lib/profiles.js';
import { useDms } from '../state/DmProvider.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** `/messages/:pubkey` — one thread, decrypted, with a composer. */
export function Conversation(): JSX.Element {
  const { pubkey = '' } = useParams();
  const { tag } = useTag();
  const { thread, send, markRead } = useDms();
  const { say } = useToast();

  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const valid = HEX64.test(pubkey);
  const messages = thread(pubkey);

  useEffect(() => {
    if (!valid) return;
    markRead(pubkey);
  }, [valid, pubkey, markRead, messages.length]);

  useEffect(() => {
    if (!valid) return;
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [valid, messages.length]);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    void fetchProfile(pubkey).then((meta) => {
      if (!live || !meta) return;
      setName(meta.name?.trim() || '');
    });
    return () => {
      live = false;
    };
  }, [valid, pubkey]);

  const submit = async (): Promise<void> => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await send(pubkey, draft);
      setDraft('');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setSending(false);
    }
  };

  if (!valid) {
    return (
      <div className="shell empty">
        <h2>No such writer.</h2>
      </div>
    );
  }

  return (
    <div className="shell dm-thread-shell">
      {sending ? <Spraying stage="spraying" /> : null}

      <div className="dm-head">
        <Link to="/messages" className="btn btn--ghost btn--sm">
          Back
        </Link>
        <Link to={`/w/${pubkey}`} className="writer">
          <Identicon pubkey={pubkey} size={32} />
          <span className="writer__name">{name || 'unnamed'}</span>
          <span className="writer__mark">{fingerprint(pubkey)}</span>
        </Link>
      </div>

      <div className="dm-thread">
        {messages.length === 0 ? (
          <div className="empty">
            <h2>Nothing said yet.</h2>
            <p className="muted">Say hello.</p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.key} className={`bubble bubble--${message.mine ? 'mine' : 'theirs'}`}>
              <p className="bubble__text">{message.text}</p>
              <span className="mono faint bubble__time">{ago(message.createdAt)}</span>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <div className="dm-composer">
        <textarea
          className="textarea dm-composer__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, DM_TEXT_MAX))}
          placeholder="..."
          rows={2}
        />
        <button
          type="button"
          className="btn btn--go btn--sm sticker"
          onClick={() => void submit()}
          disabled={!draft.trim() || sending}
        >
          Send
        </button>
      </div>
    </div>
  );
}
