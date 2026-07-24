import { COPY, KINDS, type EventRef, type SignedEvent } from '@1nky/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { WriterChip } from '../components/WriterChip.js';
import { Spraying } from '../components/Spraying.js';
import { getPref, setPref } from '../lib/db.js';
import { fetchFlick, type Flick } from '../lib/feed.js';
import { ago } from '../lib/platform.js';
import { buffEvents, postComment, type Stage } from '../lib/publish.js';
import { relay } from '../lib/relay.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

interface Comment {
  id: string;
  pubkey: string;
  createdAt: number;
  body: string;
}

/** One flick, full size, with its replies. */
export function FlickDetail(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { tag } = useTag();
  const { say } = useToast();

  const [flick, setFlick] = useState<Flick | null>(null);
  const [missing, setMissing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [confirmBuff, setConfirmBuff] = useState(false);

  useEffect(() => {
    let live = true;
    setFlick(null);
    setMissing(false);
    void fetchFlick(id).then((found) => {
      if (!live) return;
      setFlick(found);
      setMissing(found === null);
    });
    return () => {
      live = false;
    };
  }, [id]);

  // Replies stream in live; the wall does not need a refresh button.
  useEffect(() => {
    if (!id) return;
    setComments([]);
    const sub = relay.subscribe([{ kinds: [KINDS.COMMENT], '#E': [id], limit: 200 }], {
      onEvent: (event: SignedEvent) => {
        setComments((current) =>
          current.some((c) => c.id === event.id)
            ? current
            : [
                ...current,
                { id: event.id, pubkey: event.pubkey, createdAt: event.created_at, body: event.content },
              ].sort((a, b) => a.createdAt - b.createdAt),
        );
      },
    });
    return () => sub.close();
  }, [id]);

  const parent = useMemo<EventRef | null>(
    () => (flick ? { id: flick.id, pubkey: flick.pubkey, kind: KINDS.FLICK } : null),
    [flick],
  );

  const mine = Boolean(tag && flick && tag.pubkey === flick.pubkey);

  const send = useCallback(async () => {
    if (!tag || !parent || !draft.trim()) return;
    setStage('spraying');
    try {
      await postComment(tag, parent, draft, { onStage: setStage });
      setDraft('');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
    }
  }, [tag, parent, draft, say]);

  const buff = useCallback(async () => {
    if (!tag || !flick) return;
    setConfirmBuff(false);
    setStage('spraying');
    try {
      await buffEvents(tag, [flick.id], [KINDS.FLICK], { onStage: setStage });
      // Optimistic: the relay drops it, but the local wall should not wait.
      const hidden = await getPref<string[]>('buffed', []);
      await setPref('buffed', [flick.id, ...hidden]);
      say(COPY.buff.done);
      navigate('/', { replace: true });
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
    }
  }, [tag, flick, say, navigate]);

  if (missing) {
    return (
      <div className="shell empty">
        <h2>Gone.</h2>
        <p className="muted">Buffed, or never here.</p>
        <Link to="/" className="btn btn--ghost btn--sm" style={{ marginTop: 20 }}>
          Back to the wall
        </Link>
      </div>
    );
  }

  if (!flick) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <img
        className="preview"
        src={flick.url}
        alt={flick.alt ?? flick.caption}
        width={flick.width}
        height={flick.height}
      />

      <div className="row spread">
        <WriterChip pubkey={flick.pubkey} name={flick.writer} size={28} />
        <span className="mono faint">{ago(flick.createdAt)}</span>
      </div>

      {flick.caption ? <p>{flick.caption}</p> : null}

      {mine ? (
        <div>
          {confirmBuff ? (
            <div className="panel panel--hazard stack">
              <p>
                <strong>{COPY.buff.confirm}</strong>
              </p>
              <div className="row">
                <button type="button" className="btn btn--danger btn--sm" onClick={() => void buff()}>
                  {COPY.buff.label}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setConfirmBuff(false)}
                >
                  Leave it up
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmBuff(true)}>
              {COPY.buff.label}
            </button>
          )}
        </div>
      ) : null}

      <hr className="rule" />

      <section className="stack">
        <p className="kicker">{comments.length === 0 ? 'no replies' : `${comments.length} replies`}</p>

        <ul className="list-reset">
          {comments.map((comment) => (
            <li key={comment.id} className="comment">
              <div className="row spread">
                <WriterChip pubkey={comment.pubkey} size={18} />
                <span className="mono faint">{ago(comment.createdAt)}</span>
              </div>
              <p className="comment__body">{comment.body}</p>
            </li>
          ))}
        </ul>

        {tag ? (
          <div className="field">
            <label htmlFor="reply">Say something</label>
            <textarea
              id="reply"
              className="textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 600))}
              placeholder="..."
            />
            <button
              type="button"
              className="btn btn--go btn--sm sticker"
              onClick={() => void send()}
              disabled={!draft.trim()}
            >
              Put it up
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
