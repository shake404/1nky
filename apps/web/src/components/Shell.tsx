import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { relay, type ConnectionState } from '../lib/relay.js';
import { subscribeShoutsSeen, unseenShoutCount } from '../lib/shoutouts.js';
import { useTag } from '../state/TagProvider.js';
import { BackupNag } from './BackupNag.js';
import { CrewSwitcher } from './CrewSwitcher.js';
import { InstallPrompt } from './InstallPrompt.js';

function ConnectionDot(): JSX.Element {
  const [state, setState] = useState<ConnectionState>('idle');
  useEffect(() => relay.watch(setState), []);
  return (
    <span
      className={`dot ${state === 'open' ? 'dot--live' : ''}`}
      title={state === 'open' ? 'Connected' : 'Reconnecting'}
      aria-label={state === 'open' ? 'Connected' : 'Reconnecting'}
    />
  );
}

/**
 * Desktop top-nav: persistent route links in the topbar from 980px up. The
 * mobile bottom dock (below) still carries the same core routes — the brief
 * is explicit that the bottom nav stays.
 *
 * `wide` marks a link that only appears once there is genuinely room for it
 * (1180px, the shell's own width). Seven labels already fill the bar at 980px;
 * "Happenings" is the longest word in the nav and would push the row into the
 * speaking-as tape. So it waits for the space instead of crowding, and on
 * anything narrower the boards hub is the door — which is where a phone finds it
 * too, since the bottom dock is full at eight tabs.
 */
const TOPNAV = [
  { to: '/', label: 'Wall', end: true, wide: false },
  { to: '/explore', label: 'Explore', end: false, wide: false },
  { to: '/search', label: 'Search', end: false, wide: false },
  { to: '/boards', label: 'Boards', end: false, wide: false },
  { to: '/happenings', label: 'Happenings', end: false, wide: true },
  { to: '/post', label: 'Post', end: false, wide: false },
  { to: '/me', label: 'Mine', end: false, wide: false },
  { to: '/crews', label: 'Crew', end: false, wide: false },
] as const;

/**
 * The way to search on a phone.
 *
 * The bottom dock is full — eight tabs is already the ceiling for a phone-width
 * row, and a ninth would shrink every label past reading. So search lives in the
 * top bar instead: the glyph below, always in reach at the top of every screen,
 * and the worded link in the desktop nav above (where it hides, because the word
 * is already there).
 *
 * Drawn rather than typed: the geometric glyphs the dock uses have no magnifier
 * among them, and an emoji would be the only colour image in the whole chrome.
 */
function SearchGlyph(): JSX.Element {
  return (
    <NavLink
      to="/search"
      className={({ isActive }) => `topbar__search ${isActive ? 'is-active' : ''}`}
      aria-label="Search"
      title="Search"
    >
      <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true" focusable="false">
        <circle cx="8.5" cy="8.5" r="5.4" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="12.7" y1="12.7" x2="18" y2="18" stroke="currentColor" strokeWidth="2" />
      </svg>
    </NavLink>
  );
}

/**
 * Shout-outs, and whether there are new ones.
 *
 * A glyph in the top bar rather than a ninth tab or an eighth word. The dock is
 * full at eight (see TABS) and the desktop row is full at seven-plus-one; this
 * is the same call the search glyph made, except it stays visible at every
 * width, because there is no worded twin of it anywhere else.
 *
 * The dot is the whole feature on this end: a writer should be able to tell
 * from any screen that somebody said their name, without opening anything. It
 * clears the moment the screen is opened, because the screen writes the
 * last-looked stamp this subscribes to.
 */
function ShoutsGlyph({ pubkey }: { pubkey: string }): JSX.Element {
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    if (!pubkey) return;
    let live = true;
    const controller = new AbortController();
    void unseenShoutCount(pubkey, controller.signal)
      .then((count) => {
        if (live) setUnseen(count);
      })
      // A wall we cannot reach is not a reason to shout. Stay quiet.
      .catch(() => undefined);
    const stop = subscribeShoutsSeen(() => {
      if (live) setUnseen(0);
    });
    return () => {
      live = false;
      controller.abort();
      stop();
    };
  }, [pubkey]);

  const label = unseen > 0 ? `Shout-outs, ${String(unseen)} new` : 'Shout-outs';

  return (
    <NavLink
      to="/mentions"
      className={({ isActive }) => `topbar__glyph ${isActive ? 'is-active' : ''}`}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true" focusable="false">
        {/* A speech bubble: somebody talking about you, somewhere else. */}
        <path
          d="M2.6 3.4h14.8v10H8.2L4.4 17v-3.6H2.6z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {unseen > 0 ? <span className="topbar__badge" aria-hidden="true" /> : null}
    </NavLink>
  );
}

export function TopBar(): JSX.Element {
  const { tag } = useTag();
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <div className="row" style={{ gap: 18, minWidth: 0 }}>
          <Link to="/" className="wordmark chrome">
            1NKY
          </Link>
          <nav className="topnav" aria-label="Main">
            {TOPNAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [item.wide ? 'topnav__wide' : '', isActive ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <SearchGlyph />
          {tag ? <ShoutsGlyph pubkey={tag.pubkey} /> : null}
          {/* The device holds ONE persisted tag (single-slot `tag` store — see
              db.ts). "Posting as a crew" is an in-memory signer overlay: the
              switcher points the SIGNER at a crew key from the separate ring
              for the session without ever touching that slot. On reload we are
              back on the writer's own tag unless the selection is re-hydrated
              from the ring. */}
          {tag ? <CrewSwitcher /> : null}
          <ConnectionDot />
          {tag ? <span className="mono faint">{tag.mark}</span> : null}
        </div>
      </div>
    </header>
  );
}

const TABS = [
  { to: '/', glyph: '▚', label: 'Wall', end: true },
  { to: '/explore', glyph: '◎', label: 'Explore', end: false },
  { to: '/boards', glyph: '▦', label: 'Boards', end: false },
  { to: '/post', glyph: '✚', label: 'Post', end: false },
  { to: '/messages', glyph: '✉', label: 'Word', end: false },
  { to: '/me', glyph: '◱', label: 'Mine', end: false },
  { to: '/crews', glyph: '⬢', label: 'Crew', end: false },
  { to: '/settings', glyph: '⚙', label: 'Setup', end: false },
] as const;

export function TabBar(): JSX.Element {
  return (
    <nav className="tabbar" aria-label="Main" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => (isActive ? 'is-active' : '')}
        >
          <span className="glyph" aria-hidden="true">
            {tab.glyph}
          </span>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** The signed-in chrome: bar, nags, content, tabs. */
export function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="app">
      <TopBar />
      <main>
        <div className="shell">
          <InstallPrompt />
          <BackupNag />
        </div>
        {children}
      </main>
      <TabBar />
    </div>
  );
}