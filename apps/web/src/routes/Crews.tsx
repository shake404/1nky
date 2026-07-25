import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { fetchWriterCrews, loadFoundedCrews } from '../lib/crews.js';
import { fetchProfile } from '../lib/profiles.js';
import { useTag } from '../state/TagProvider.js';

interface CrewRow {
  pubkey: string;
  name: string | null;
  foundedByMe: boolean;
}

/**
 * `/crews` — the hub of every crew tied to this writer.
 *
 * Two sources, merged and deduped by pubkey:
 *   - the local `founded-crews` pointer (offline-first, instant; this device
 *     minted these), and
 *   - the repping claim on the writer's own kind-0 (`fetchWriterCrews`).
 *
 * The crew SECRET is never held here (post-as-crew stays the blackbook-swap
 * flow); this is just a directory of links into each crew page.
 */
export function Crews(): JSX.Element {
  const { tag } = useTag();
  const [rows, setRows] = useState<CrewRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void (async () => {
      const local = await loadFoundedCrews();
      const remotePubkeys = await fetchWriterCrews(tag.pubkey).catch(() => [] as string[]);

      const byPubkey = new Map<string, CrewRow>();
      for (const c of local) {
        byPubkey.set(c.pubkey, { pubkey: c.pubkey, name: c.name, foundedByMe: true });
      }
      for (const pk of remotePubkeys) {
        if (!byPubkey.has(pk)) byPubkey.set(pk, { pubkey: pk, name: null, foundedByMe: false });
      }

      // Fill in names for repped crews we did not found ourselves. The crew's
      // own kind-0 carries its name; a miss reads as "unnamed crew".
      const unknown = [...byPubkey.values()].filter((r) => r.name === null);
      await Promise.allSettled(
        unknown.map(async (r) => {
          const meta = await fetchProfile(r.pubkey);
          if (live) r.name = meta?.name?.trim() || null;
        }),
      );

      if (live) {
        setRows([...byPubkey.values()]);
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [tag]);

  if (!tag) return <div className="shell empty" />;

  if (loading) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="shell pad stack stack--wide">
        <div>
          <span className="tape">{COPY.crew.label}</span>
          <h2 style={{ marginTop: 12 }}>No crews on your tag yet.</h2>
        </div>
        <p className="muted">Start one, hand off the blackbook, and put a crew on the wall.</p>
        <Link to="/crew/new" className="btn btn--go btn--block sticker">
          {COPY.crew.action}
        </Link>
        <Link to="/crew/import" className="kicker" style={{ textDecoration: 'underline' }}>
          Already hold a crew&apos;s blackbook? Bring it in.
        </Link>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      <div>
        <span className="tape">{COPY.crew.label}</span>
        <h2 style={{ marginTop: 12 }}>Your crews</h2>
      </div>

      <div className="stack">
        {rows.map((row) => (
          <Link key={row.pubkey} to={`/crew/${row.pubkey}`} className="writer dm-row" style={{ gap: 12 }}>
            <Identicon pubkey={row.pubkey} size={40} />
            <div className="dm-row__main" style={{ gap: 3 }}>
              <span className="writer__name">{row.name || 'unnamed crew'}</span>
              <span className="writer__mark">{fingerprint(row.pubkey)}</span>
            </div>
            {row.foundedByMe ? <span className="kicker">founder</span> : null}
          </Link>
        ))}
      </div>

      <Link to="/crew/new" className="btn btn--go btn--block sticker">
        {COPY.crew.action}
      </Link>
      <Link to="/crew/import" className="kicker" style={{ textDecoration: 'underline' }}>
        Hold a crew&apos;s blackbook? Bring it in.
      </Link>
    </div>
  );
}