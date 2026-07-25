import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { Identicon } from '../components/Identicon.js';
import { fetchCrew, fetchWriterCrews, type CrewPage } from '../lib/crews.js';
import { fetchProfile } from '../lib/profiles.js';
import { publishProfile } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `/crew/:pubkey` — a crew page. A writer page for the crew's own pubkey plus
 * crew-specific chrome: the crew-signed roster, the site-issued verified badge,
 * and the writers who self-declared this crew (repping). Roster and repping are
 * never merged — merging would silently upgrade every unilateral claim to look
 * verified.
 */
export function Crew(): JSX.Element {
  const { pubkey = '' } = useParams();
  const { tag } = useTag();
  const { say } = useToast();
  const [page, setPage] = useState<CrewPage | null>(null);
  const [loading, setLoading] = useState(true);

  const valid = HEX64.test(pubkey);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    setLoading(true);
    void fetchCrew(pubkey).then((found) => {
      if (live) {
        setPage(found);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [pubkey, valid]);

  if (!valid) {
    return (
      <div className="shell empty">
        <h2>No such crew.</h2>
      </div>
    );
  }
  if (loading || !page) {
    return (
      <div className="shell empty">
        <p className="kicker">loading</p>
      </div>
    );
  }

  const { crew, members, repping, flicks } = page;

  const repThisCrew = async (): Promise<void> => {
    if (!tag) return;
    const current = await fetchWriterCrews(tag.pubkey);
    if (current.includes(crew.pubkey)) {
      say('Already repping it.', 'hazard');
      return;
    }
    const meta = await fetchProfile(tag.pubkey);
    try {
      await publishProfile(tag, {
        first: false,
        bio: meta?.bio,
        city: meta?.city,
        crews: [...current, crew.pubkey],
      });
      say('Repping it.');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    }
  };

  return (
    <div className="shell shell--wide pad stack stack--wide">
      <div className="row" style={{ gap: 14 }}>
        <Identicon pubkey={pubkey} size={64} />
        <div style={{ minWidth: 0 }}>
          <h2>{crew.tag || 'unnamed crew'}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {fingerprint(pubkey)}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          {crew.verified ? <p className="kicker" style={{ color: 'var(--sodium)' }}>verified</p> : null}
          {crew.founderPubkey ? (
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: 4 }}>
              founded by{' '}
              <Link to={`/w/${crew.founderPubkey}`} className="mono" style={{ textDecoration: 'underline' }}>
                {fingerprint(crew.founderPubkey)}
              </Link>
              {crew.foundedAt ? ` · est. ${new Date(crew.foundedAt * 1000).getFullYear()}` : ''}
            </p>
          ) : null}
          {page.degraded ? <p className="help" style={{ marginTop: 4 }}>Showing what the wall has directly.</p> : null}
        </div>
      </div>

      {tag ? (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Link to={`/messages/${pubkey}`} className="btn btn--go btn--sm sticker">
            Send a message
          </Link>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void repThisCrew()}>
            Rep this crew
          </button>
        </div>
      ) : null}

      <hr className="rule" />

      <section className="stack">
        <h3>Roster ({members.length})</h3>
        {members.length === 0 ? (
          <p className="muted">No one on the signed roster yet.</p>
        ) : (
          <div className="chips" style={{ gap: 10 }}>
            {members.map((m) => (
              <Link key={m.pubkey} to={`/w/${m.pubkey}`} className="writer" style={{ gap: 8 }}>
                <Identicon pubkey={m.pubkey} size={22} />
                <span className="writer__name">{m.tag || 'unnamed'}</span>
                <span className="writer__mark">{m.mark}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {repping.length > 0 ? (
        <section className="stack">
          <h3>Reppin&apos; ({repping.length})</h3>
          <p className="help" style={{ marginTop: 0 }}>
            A claim, not a roster — these writers say they are down; the crew has not necessarily said so.
          </p>
          <div className="chips" style={{ gap: 10 }}>
            {repping.map((m) => (
              <Link key={m.pubkey} to={`/w/${m.pubkey}`} className="writer" style={{ gap: 8 }}>
                <Identicon pubkey={m.pubkey} size={22} />
                <span className="writer__name">{m.tag || 'unnamed'}</span>
                <span className="writer__mark">{m.mark}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <hr className="rule" />

      {flicks.length === 0 ? (
        <div className="empty">
          <h2>No flicks up yet.</h2>
          <p className="muted">This crew has not put anything up.</p>
        </div>
      ) : (
        <div className="wall">
          {flicks.map((flick) => (
            <FlickCard key={flick.id} flick={{ ...flick, writer: crew.tag ?? flick.writer }} />
          ))}
        </div>
      )}
    </div>
  );
}