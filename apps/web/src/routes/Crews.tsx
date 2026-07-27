import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { ensureCrewBackups, syncCrewKeys } from '../lib/crew-sync.js';
import { fetchWriterCrews, loadFoundedCrews } from '../lib/crews.js';
import { fetchProfile } from '../lib/profiles.js';
import { useTag } from '../state/TagProvider.js';

interface CrewRow {
  pubkey: string;
  name: string | null;
  foundedByMe: boolean;
  avatarSha256: string | null;
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
      // Seed backups for any crew this device holds but never backed up (crews
      // founded before sync existed), then pull any this tag holds elsewhere.
      // Both idempotent and best-effort — a miss just leaves the list as-is.
      await ensureCrewBackups(tag).catch(() => undefined);
      await syncCrewKeys(tag).catch(() => undefined);
      const local = await loadFoundedCrews();
      const remotePubkeys = await fetchWriterCrews(tag.pubkey).catch(() => [] as string[]);

      const byPubkey = new Map<string, CrewRow>();
      for (const c of local) {
        byPubkey.set(c.pubkey, { pubkey: c.pubkey, name: c.name, foundedByMe: true, avatarSha256: null });
      }
      for (const pk of remotePubkeys) {
        if (!byPubkey.has(pk)) byPubkey.set(pk, { pubkey: pk, name: null, foundedByMe: false, avatarSha256: null });
      }

      // Each crew's own kind-0 carries its avatar (and its name, for crews we
      // did not found). Fetch it for every row so the list shows the crew's
      // sticker, not just an identicon — a miss falls back to the identicon.
      await Promise.allSettled(
        [...byPubkey.values()].map(async (r) => {
          const meta = await fetchProfile(r.pubkey);
          if (!live) return;
          if (r.name === null) r.name = meta?.name?.trim() || null;
          r.avatarSha256 = meta?.avatarSha256 ?? null;
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
            <Avatar pubkey={row.pubkey} avatarSha256={row.avatarSha256} size={40} alt={row.name || ''} />
            <div className="dm-row__main" style={{ gap: 3 }}>
              <span className="writer__name">{(row.name || 'unnamed crew').toUpperCase()}</span>
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