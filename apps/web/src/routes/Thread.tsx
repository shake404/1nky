import { KINDS, type EventRef } from '@1nky/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BeefChip } from '../components/BeefChip.js';
import { FlagIt } from '../components/FlagIt.js';
import { Spraying } from '../components/Spraying.js';
import { WriterChip } from '../components/WriterChip.js';
import {
  beefClock,
  fetchThreadPatient,
  MAX_REPLY_DEPTH,
  type ThreadReply,
  type ThreadView,
} from '../lib/boards.js';
import { HAPPENING_BOARD, runsLine } from '../lib/happenings.js';
import { ago } from '../lib/platform.js';
import { postComment, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const REPLY_MAX = 2000;

/**
 * `/t/:id` — one thread, all of it.
 *
 * Replies nest, but only for about four steps: past that the indentation eats
 * the column and a back-and-forth becomes unreadable on a phone. Deeper replies
 * still hang in the right place in the tree, they just stop stepping right.
 *
 * Every reply is anchored twice: at the thread's opening post, so the whole
 * thing can be pulled back as one piece, and at whatever it is actually
 * answering.
 */
export function Thread(): JSX.Element {
  const { id = '' } = useParams();
  const location = useLocation();
  // Set by the compose page: this thread went up a heartbeat ago, so the
  // first read waits out the wall's filing delay instead of calling it gone.
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh === true;
  const { tag } = useTag();
  const { say } = useToast();

  const [view, setView] = useState<ThreadView | null>(null);
  const [missing, setMissing] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  /** Which reply the inline composer is open under. Null: nothing open. */
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  /** The composer at the foot of the page, which answers the thread itself. */
  const [opDraft, setOpDraft] = useState('');

  /**
   * Read the thread. `alive` lets a navigation away from this thread throw the
   * answer out rather than paint it over whatever is on screen now.
   */
  const load = useCallback(
    async (alive: () => boolean = () => true, expectReplies = 0): Promise<void> => {
      try {
        const patient = fresh || expectReplies > 0;
        const found = await fetchThreadPatient(id, { tries: patient ? 4 : 1, expectReplies });
        if (!alive()) return;
        setView(found);
        setMissing(found === null);
      } catch {
        if (alive()) setMissing(true);
      }
    },
    [id, fresh],
  );

  useEffect(() => {
    let live = true;
    setView(null);
    setMissing(false);
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  const op = view?.thread ?? null;

  const root = useMemo<EventRef | null>(
    () => (op ? { id: op.id, pubkey: op.writer.pubkey, kind: KINDS.NOTE } : null),
    [op],
  );

  /** Flat index of the reply tree, so a reply's parent ref is one lookup. */
  const byId = useMemo(() => {
    const map = new Map<string, ThreadReply>();
    const walk = (nodes: readonly ThreadReply[]): void => {
      for (const node of nodes) {
        map.set(node.id, node);
        walk(node.replies);
      }
    };
    walk(view?.comments ?? []);
    return map;
  }, [view]);

  const send = useCallback(
    async (parentId: string | null, text: string): Promise<void> => {
      if (!tag || !root || !text.trim() || stage) return;

      // Answering the opening post: the parent IS the top of the thread.
      // Answering a reply: the parent is that reply, the top is still the OP.
      const target = parentId ? byId.get(parentId) : null;
      const parent: EventRef = target
        ? { id: target.id, pubkey: target.writer.pubkey, kind: KINDS.COMMENT }
        : root;

      setStage('spraying');
      try {
        await postComment(tag, parent, text, { root, onStage: setStage });
        if (parentId) {
          setReplyDraft('');
          setReplyingTo(null);
        } else {
          setOpDraft('');
        }
        await load(() => true, (op?.replyCount ?? 0) + 1);
      } catch (problem) {
        say(problem instanceof Error ? problem.message : 'That did not go up.', 'hazard');
      } finally {
        setStage(null);
      }
    },
    [tag, root, stage, byId, load, say, op],
  );

  if (missing) {
    return (
      <div className="shell empty">
        <h2>Gone.</h2>
        <p className="muted">Buffed, ran out of time, or never here.</p>
        <Link to="/boards" className="btn btn--ghost btn--sm" style={{ marginTop: 20 }}>
          Back to the boards
        </Link>
      </div>
    );
  }

  if (!view || !op || !root) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  const clock = beefClock(op.expiresAt);
  // A thread with a date on it carries the happening marker among its boards.
  // That slug is plumbing: the tape at the top wants the place, and the line
  // below already says when it runs, so the countdown steps aside for it.
  const happeningAt = op.happeningAt;
  const board = op.boards.find((slug) => slug !== HAPPENING_BOARD) ?? op.boards[0];

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <Link to={board ? `/b/${board}` : '/boards'} className="tape">
          {board ?? 'walls'}
        </Link>
        {op.subject ? <h2 style={{ marginTop: 12 }}>{op.subject}</h2> : null}
      </div>

      <div className="row spread">
        <WriterChip pubkey={op.writer.pubkey} name={op.writer.tag ?? undefined} size={28} />
        <span className="mono faint">{ago(op.createdAt)}</span>
      </div>

      {happeningAt !== null ? (
        <div className="row">
          <span className="runs-line">{runsLine(happeningAt)}</span>
        </div>
      ) : clock ? (
        <div className="row">
          <BeefChip clock={clock} />
        </div>
      ) : null}

      <p className="thread__body">{op.content}</p>

      {tag && tag.pubkey !== op.writer.pubkey ? (
        <FlagIt target={{ pubkey: op.writer.pubkey, eventId: op.id, kind: KINDS.NOTE }} onStage={setStage} />
      ) : null}

      <hr className="rule" />

      <p className="kicker">
        {op.replyCount === 0
          ? 'no replies'
          : `${op.replyCount} ${op.replyCount === 1 ? 'reply' : 'replies'}`}
      </p>

      {view.comments.length > 0 ? (
        <ul className="list-reset">
          {view.comments.map((reply) => (
            <ReplyNode
              key={reply.id}
              reply={reply}
              depth={0}
              canReply={Boolean(tag)}
              openId={replyingTo}
              draft={replyDraft}
              busy={stage !== null}
              onOpen={(replyId) => {
                setReplyingTo(replyId);
                setReplyDraft('');
              }}
              onDraft={setReplyDraft}
              onSend={(parentId) => void send(parentId, replyDraft)}
            />
          ))}
        </ul>
      ) : null}

      {tag ? (
        <div className="field">
          <label htmlFor="thread-reply">Say something</label>
          <textarea
            id="thread-reply"
            className="textarea"
            value={opDraft}
            onChange={(event) => setOpDraft(event.target.value.slice(0, REPLY_MAX))}
            placeholder="..."
          />
          <button
            type="button"
            className="btn btn--go btn--sm sticker"
            onClick={() => void send(null, opDraft)}
            disabled={!opDraft.trim() || stage !== null}
          >
            Put it up
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface NodeProps {
  reply: ThreadReply;
  depth: number;
  canReply: boolean;
  openId: string | null;
  draft: string;
  busy: boolean;
  onOpen: (id: string | null) => void;
  onDraft: (text: string) => void;
  onSend: (parentId: string) => void;
}

/** One reply and its branch. Indentation stops at {@link MAX_REPLY_DEPTH}. */
function ReplyNode(props: NodeProps): JSX.Element {
  const { reply, depth, canReply, openId, draft, busy, onOpen, onDraft, onSend } = props;
  const step = Math.min(depth, MAX_REPLY_DEPTH);
  const open = openId === reply.id;

  return (
    <li className="reply" data-depth={step} style={{ marginLeft: step * 16 }}>
      <div className="comment">
        <div className="row spread">
          <WriterChip pubkey={reply.writer.pubkey} name={reply.writer.tag ?? undefined} size={18} />
          <span className="mono faint">{ago(reply.createdAt)}</span>
        </div>
        <p className="comment__body">{reply.content}</p>

        {canReply ? (
          open ? (
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor={`reply-${reply.id}`}>Back at them</label>
              <textarea
                id={`reply-${reply.id}`}
                className="textarea"
                value={draft}
                onChange={(event) => onDraft(event.target.value.slice(0, REPLY_MAX))}
                placeholder="..."
              />
              <div className="row" style={{ gap: 10 }}>
                <button
                  type="button"
                  className="btn btn--go btn--sm sticker"
                  onClick={() => onSend(reply.id)}
                  disabled={!draft.trim() || busy}
                >
                  Put it up
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpen(null)}>
                  Never mind
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="kicker reply__open"
              onClick={() => onOpen(reply.id)}
            >
              Reply
            </button>
          )
        ) : null}
      </div>

      {reply.replies.length > 0 ? (
        <ul className="list-reset">
          {reply.replies.map((child) => (
            <ReplyNode
              key={child.id}
              reply={child}
              depth={depth + 1}
              canReply={canReply}
              openId={openId}
              draft={draft}
              busy={busy}
              onOpen={onOpen}
              onDraft={onDraft}
              onSend={onSend}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
