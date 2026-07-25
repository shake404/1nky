import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { relay, type ConnectionState } from '../lib/relay.js';
import { useTag } from '../state/TagProvider.js';
import { BackupNag } from './BackupNag.js';
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
 */
const TOPNAV = [
  { to: '/', label: 'Wall', end: true },
  { to: '/explore', label: 'Explore', end: false },
  { to: '/search', label: 'Search', end: false },
  { to: '/boards', label: 'Boards', end: false },
  { to: '/post', label: 'Post', end: false },
  { to: '/me', label: 'Mine', end: false },
  { to: '/crews', label: 'Crew', end: false },
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
                className={({ isActive }) => (isActive ? 'is-active' : '')}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <SearchGlyph />
          {tag ? (
            // The device holds ONE tag at a time (single-identity store — see
            // db.ts). Posting as a crew works by importing the crew's blackbook
            // through the existing restore flow, which swaps that single slot.
            // We never built a multi-key switcher: the indicator below names
            // whichever identity is active right now and offers the quick way
            // back to the writer's own tag (restore). That is the tradeoff.
            <Link to="/restore" className="speaking-as" title="Switch / get your tag back">
              speaking as {tag.name}
            </Link>
          ) : null}
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