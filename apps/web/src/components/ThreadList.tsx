import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  beefClock,
  fetchBoard,
  threadHeadline,
  type BoardMeta,
  type ThreadRow,
} from '../lib/boards.js';
import { ago } from '../lib/platform.js';
import { BeefChip } from './BeefChip.js';
import { WriterChip } from './WriterChip.js';

/**
 * One board's talk, in the two pieces every board-shaped page needs: the read
 * (a hook) and the column (a component).
 *
 * Pulled out of the board page so a page pinned to ONE board — /holler — reads
 * the same list through the same code rather than growing a second copy of it.
 * The hook drops threads whose clock has already run out, which is the rule the
 * board page has always applied before counting or rendering anything.
 */

export interface BoardThreads {
  /** What the wall says this board is. Null until the first read lands. */
  board: BoardMeta | null;
  /** Threads that are still alive, newest activity first. */
  threads: ThreadRow[];
  loading: boolean;
  /** True when the wall could not be reached at all. */
  failed: boolean;
  /** Non-null when there is another page to ask for. */
  cursor: string | null;
  /** Ask for the next page. */
  more: () => void;
  /** Throw away what we have and read the board again. */
  reload: () => void;
}

export function useBoardThreads(slug: string): BoardThreads {
  const [board, setBoard] = useState<BoardMeta | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      setLoading(true);
      try {
        const page = await fetchBoard(slug, from);
        setBoard(page.board);
        setThreads((current) => {
          const merged = from ? [...current, ...page.threads] : page.threads;
          const seen = new Set<string>();
          return merged.filter((t) => !seen.has(t.id) && seen.add(t.id));
        });
        setCursor(page.cursor);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    setThreads([]);
    setCursor(null);
    void load(null);
  }, [load]);

  const more = useCallback(() => {
    void load(cursor);
  }, [load, cursor]);

  const reload = useCallback(() => {
    setThreads([]);
    setCursor(null);
    void load(null);
  }, [load]);

  return {
    board,
    threads: threads.filter((t) => !beefClock(t.expiresAt)?.gone),
    loading,
    failed,
    cursor,
    more,
    reload,
  };
}

/** The column of threads. */
export function ThreadList({ threads }: { threads: readonly ThreadRow[] }): JSX.Element {
  return (
    <ul className="list-reset stack">
      {threads.map((thread) => (
        <li key={thread.id}>
          <ThreadRowCard thread={thread} />
        </li>
      ))}
    </ul>
  );
}

/** One row in the thread list. */
export function ThreadRowCard({ thread }: { thread: ThreadRow }): JSX.Element {
  const clock = beefClock(thread.expiresAt);
  const headline = threadHeadline(thread);
  const showExcerpt = Boolean(thread.subject && thread.excerpt.trim());

  return (
    <Link to={`/t/${thread.id}`} className="thread">
      <div className="thread__top">
        <span className="thread__subject">{headline}</span>
        {clock ? <BeefChip clock={clock} /> : null}
      </div>

      {showExcerpt ? <p className="thread__excerpt muted">{thread.excerpt}</p> : null}

      <div className="thread__meta">
        <WriterChip pubkey={thread.writer.pubkey} name={thread.writer.tag ?? undefined} size={18} linked={false} />
        <span className="mono faint">
          {thread.replyCount === 0
            ? 'no replies'
            : `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`}
          {' · '}
          {ago(thread.lastReplyAt ?? thread.createdAt)}
        </span>
      </div>
    </Link>
  );
}
