import { COPY, KINDS, type EventRef, type SignedEvent } from '@1nky/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AgeDots } from '../components/AgeDots.js';
import { FlagIt } from '../components/FlagIt.js';
import { IgnoreWriter } from '../components/IgnoreWriter.js';
import { MentionBox } from '../components/MentionBox.js';
import { WriterChip } from '../components/WriterChip.js';
import { Spraying } from '../components/Spraying.js';
import { getPref, setPref } from '../lib/db.js';
import { fetchFlick, fetchWriterSummary, type Flick, type WriterSummary } from '../lib/feed.js';
import { candidatesFrom, extractMentions, type MentionCandidate } from '../lib/mentions.js';
import { ago } from '../lib/platform.js';
import { buffEvents, postComment, type Stage } from '../lib/publish.js';
import { relay } from '../lib/relay.js';
import { useActiveTag, useTag } from '../state/TagProvider.js';
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
  // `tag` (me) owns buffing and the mine/flag checks; `active` only signs the
  // comment (own tag, or a crew when the switcher is on).
  const { tag } = useTag();
  const { active, actingAsCrew } = useActiveTag();
  const { say } = useToast();

  const [flick, setFlick] = useState<Flick | null>(null);
  const [writer, setWriter] = useState<WriterSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [confirmBuff, setConfirmBuff] = useState(false);

  useEffect(() => {
    let live = true;
    setFlick(null);
    setWriter(null);
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

  /**
   * How long the writer has been on the wall, for the byline.
   *
   * Asked for HERE and nowhere in a grid: one lookup on a screen showing one
   * post is fine, the same lookup once per tile on a wall of twenty is not —
   * which is why `WriterChip` never does this itself.
   */
  useEffect(() => {
    const author = flick?.pubkey;
    if (!author) return;
    const controller = new AbortController();
    void fetchWriterSummary(author, controller.signal).then((found) => {
      if (!controller.signal.aborted) setWriter(found);
    });
    return () => controller.abort();
  }, [flick?.pubkey]);

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
    () =>
      flick
        ? { id: flick.id, pubkey: flick.pubkey, kind: flick.mediaType === 'video' ? KINDS.VIDEO : KINDS.FLICK }
        : null,
    [flick],
  );

  const mine = Boolean(tag && flick && tag.pubkey === flick.pubkey);

  // Who you can @: the writer whose flick this is plus everyone who has
  // commented. No global directory — the people on this page are the pool.
  const candidates = useMemo<MentionCandidate[]>(
    () =>
      candidatesFrom([
        ...(flick ? [{ pubkey: flick.pubkey, tag: flick.writer ?? writer?.tag ?? null }] : []),
        ...comments.map((c) => ({ pubkey: c.pubkey, tag: null })),
      ]),
    [flick, writer, comments],
  );

  const send = useCallback(async () => {
    if (!active || !parent || !draft.trim()) return;
    const mentions = extractMentions(draft, candidates);
    setStage('spraying');
    try {
      await postComment(active, parent, draft, {
        mentions,
        recordOwn: actingAsCrew === null,
        onStage: setStage,
      });
      setDraft('');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
    }
  }, [active, actingAsCrew, parent, draft, say, candidates]);

  const buff = useCallback(async () => {
    if (!tag || !flick) return;
    setConfirmBuff(false);
    setStage('spraying');
    try {
      await buffEvents(tag, [flick.id], [flick.mediaType === 'video' ? KINDS.VIDEO : KINDS.FLICK], { onStage: setStage });
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

      {flick.mediaType === 'video' && flick.posterUrl ? (
        <video
          className="preview"
          src={flick.url}
          poster={flick.posterUrl}
          controls
          playsInline
          preload="metadata"
        />
      ) : (
        <img
          className="preview"
          src={flick.url}
          alt={flick.alt ?? flick.caption}
          width={flick.width}
          height={flick.height}
        />
      )}

      <div className="row spread">
        <span className="row" style={{ gap: 10 }}>
          <WriterChip pubkey={flick.pubkey} name={flick.writer ?? writer?.tag ?? undefined} size={28} />
          <AgeDots firstSeen={writer?.firstSeen} />
        </span>
        <span className="mono faint">{ago(flick.createdAt)}</span>
      </div>

      {mine ? null : (
        // Next to the byline, because both of these are about the writer, not
        // the picture: hide them, or hand them over.
        <div className="row" style={{ gap: 14 }}>
          <IgnoreWriter
            pubkey={flick.pubkey}
            onStage={setStage}
            onDone={(ignored) => {
              if (ignored) navigate('/', { replace: true });
            }}
          />
        </div>
      )}

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
      ) : parent ? (
        <FlagIt
          target={{ pubkey: flick.pubkey, eventId: flick.id, kind: parent.kind }}
          onStage={setStage}
        />
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
            <MentionBox
              id="reply"
              value={draft}
              onChange={setDraft}
              candidates={candidates}
              maxLength={600}
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
