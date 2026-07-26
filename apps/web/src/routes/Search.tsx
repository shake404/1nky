import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { FlickCard } from '../components/FlickCard.js';
import { debounce } from '../lib/debounce.js';
import {
  fetchSearch,
  isEmpty,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_LENGTH,
  type SearchResults,
} from '../lib/search.js';
import { ThreadRowCard } from './Board.js';

/**
 * `/search` — one box for the whole wall.
 *
 * Writers first: somebody who types a tag is looking for the writer who uses it,
 * and every row carries their mark, because the same name with a different mark
 * is a different writer. Then walls, because a wall is a place a writer can go
 * and keep looking; then what is up, in the same grid as everywhere else; then
 * talk. Ordered by how useful the answer is, not by how the wall happened to
 * group it.
 *
 * The box asks the wall once the typing stops. An abort controller kills the
 * previous ask on every new one so a slow answer for "sf" can never land on top
 * of the answer for "sf bay".
 */
export function Search(): JSX.Element {
  const [params] = useSearchParams();
  // A shared /search?q=… link opens with that query already in the box.
  const [term, setTerm] = useState(() => params.get('q') ?? '');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [looking, setLooking] = useState(false);
  const [failed, setFailed] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const ask = useCallback((raw: string) => {
    const q = raw.trim();
    inflight.current?.abort();
    inflight.current = null;

    if (q.length < SEARCH_MIN_LENGTH) {
      setResults(null);
      setLooking(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    inflight.current = controller;
    setLooking(true);
    setFailed(false);

    void fetchSearch(q, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setResults(found);
        setLooking(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResults(null);
        setFailed(true);
        setLooking(false);
      });
  }, []);

  const askSoon = useMemo(() => debounce(ask, SEARCH_DEBOUNCE_MS), [ask]);

  // Kick off whatever arrived in the URL, and clean up on the way out.
  useEffect(() => {
    if (term.trim().length >= SEARCH_MIN_LENGTH) ask(term);
    return () => {
      askSoon.cancel();
      inflight.current?.abort();
    };
    // Deliberately mount-only: after this, every ask comes from a keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onType = (value: string): void => {
    setTerm(value);
    if (value.trim().length < SEARCH_MIN_LENGTH) {
      askSoon.cancel();
      inflight.current?.abort();
      inflight.current = null;
      setResults(null);
      setLooking(false);
      setFailed(false);
      return;
    }
    askSoon(value);
  };

  const typed = term.trim().length >= SEARCH_MIN_LENGTH;
  const nothing = results !== null && isEmpty(results);

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div>
        <span className="tape">look</span>
        <h2 style={{ marginTop: 12 }}>Search</h2>
      </div>

      <form className="field" role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="search-q">Who or where</label>
        <input
          id="search-q"
          className="input input--search"
          type="search"
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          value={term}
          placeholder="a tag, a city, a wall…"
          onChange={(event) => onType(event.target.value)}
        />
        <p className="help">Tags, walls, captions, talk.</p>
      </form>

      <hr className="rule" />

      {!typed ? (
        <div className="empty">
          <h2>Looking for something?</h2>
          <p className="muted">Type a tag, a city, or a wall.</p>
        </div>
      ) : failed ? (
        <div className="empty">
          <h2>Could not reach the wall.</h2>
          <p className="muted">Try that again in a minute.</p>
        </div>
      ) : looking && results === null ? (
        <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
          looking
        </p>
      ) : nothing ? (
        <div className="empty">
          <h2>Nothing on the wall for that.</h2>
          <p className="muted">Try a shorter word, or a city.</p>
        </div>
      ) : results ? (
        <div className="stack stack--wide">
          {results.writers.length > 0 ? (
            <section className="stack" style={{ gap: 10 }}>
              <h3>Writers</h3>
              <div className="chips" style={{ gap: 10 }}>
                {results.writers.map((writer) => (
                  <Link
                    key={writer.pubkey}
                    to={`/w/${writer.pubkey}`}
                    className="writer"
                    style={{ gap: 8 }}
                  >
                    <Avatar
                      pubkey={writer.pubkey}
                      avatarSha256={writer.avatarSha256}
                      size={22}
                      alt={writer.tag ?? ''}
                    />
                    <span className="writer__name">{writer.tag ?? 'unnamed'}</span>
                    <span className="writer__mark">{writer.mark}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {results.boards.length > 0 ? (
            <section className="stack" style={{ gap: 10 }}>
              <h3>Walls</h3>
              <div className="chips">
                {results.boards.map((slug) => (
                  <Link key={slug} to={`/b/${slug}`} className="chip">
                    {slug}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {results.media.length > 0 ? (
            <section className="stack" style={{ gap: 10 }}>
              <h3>Up</h3>
              <div className="wall">
                {results.media.map((flick) => (
                  <FlickCard key={flick.id} flick={flick} />
                ))}
              </div>
            </section>
          ) : null}

          {results.threads.length > 0 ? (
            <section className="stack" style={{ gap: 10 }}>
              <h3>Talk</h3>
              <ul className="list-reset stack">
                {results.threads.map((thread) => (
                  <li key={thread.id}>
                    <ThreadRowCard thread={thread} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {looking ? (
            <p className="kicker" style={{ textAlign: 'center' }}>
              looking
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
