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

export function TopBar(): JSX.Element {
  const { tag } = useTag();
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <Link to="/" className="wordmark chrome">
          1NKY
        </Link>
        <div className="row">
          <ConnectionDot />
          {tag ? <span className="mono faint">{tag.mark}</span> : null}
        </div>
      </div>
    </header>
  );
}

const TABS = [
  { to: '/', glyph: '▚', label: 'Wall', end: true },
  { to: '/post', glyph: '✚', label: 'Post', end: false },
  { to: '/me', glyph: '◱', label: 'Mine', end: false },
  { to: '/settings', glyph: '⚙', label: 'Setup', end: false },
] as const;

export function TabBar(): JSX.Element {
  return (
    <nav className="tabbar" aria-label="Main">
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
