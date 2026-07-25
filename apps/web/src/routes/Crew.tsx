import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { Identicon } from '../components/Identicon.js';
import { Spraying } from '../components/Spraying.js';
import { getCrewKey, hasCrewKey } from '../lib/crew-keys.js';
import {
  fetchCrew,
  fetchWriterCrews,
  publishCrewProfile,
  resolveWriterInput,
  updateCrewRoster,
  type CrewMember,
  type CrewPage,
} from '../lib/crews.js';
import { PROFILE_BIO_MAX } from '@1nky/protocol';
import { fetchProfile } from '../lib/profiles.js';
import { publishProfile, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `/crew/:pubkey` — a crew page. A writer page for the crew's own pubkey plus
 * crew-specific chrome: the crew-signed roster, the site-issued verified badge,
 * the crew bio, and the writer who self-declared this crew (repping). Roster and
 * repping are never merged — merging would silently upgrade every unilateral
 * claim to look verified.
 *
 * Founder management panel: when this device holds the crew's key (`hasCrewKey`),
 * the page shows the panel that lets the founder put a writer on, remove a
 * writer, and edit the crew's name / bio — every change re-signed by the crew's
 * *own* key, never the founder's tag.
 */
export function Crew(): JSX.Element {
  const { pubkey = '' } = useParams();
  const { tag } = useTag();
  const { say } = useToast();
  const [page, setPage] = useState<CrewPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFounder, setIsFounder] = useState(false);
  const [founderName, setFounderName] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);

  const valid = HEX64.test(pubkey);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    setLoading(true);
    setFounderName(null);
    void fetchCrew(pubkey).then((found) => {
      if (!live) return;
      setPage(found);
      setLoading(false);
      // Resolve the founder's own tag so "founded by" reads as their name, not
      // their mark. A miss falls back to the mark (done at render).
      if (found.crew.founderPubkey) {
        void fetchProfile(found.crew.founderPubkey).then((meta) => {
          if (live) setFounderName(meta?.name?.trim() || null);
        });
      }
    });
    void hasCrewKey(pubkey).then((found) => {
      if (live) setIsFounder(found);
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

  const removeMember = async (memberPubkey: string): Promise<void> => {
    const key = await getCrewKey(crew.pubkey);
    if (!key) {
      say('You do not hold this crew on this device.', 'hazard');
      return;
    }
    setStage('spraying');
    try {
      await updateCrewRoster(key.secret, crew.pubkey, {
        name: crew.tag ?? 'crew',
        members: members.map((m) => m.pubkey).filter((pk) => pk !== memberPubkey),
        founderPubkey: crew.founderPubkey ?? undefined,
        foundedAt: crew.foundedAt ?? undefined,
      }, { onStage: setStage });
      const next = members.filter((m) => m.pubkey !== memberPubkey);
      setPage({ ...page, crew: { ...crew, memberCount: next.length }, members: next });
      say('Buffed off the roster.');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
    }
  };

  /** Lift a writer who is repping the crew onto the signed roster in one tap. */
  const putOnRoster = async (writer: CrewMember): Promise<void> => {
    if (members.some((m) => m.pubkey === writer.pubkey)) {
      say('Already on the roster.', 'hazard');
      return;
    }
    const key = await getCrewKey(crew.pubkey);
    if (!key) {
      say('You do not hold this crew on this device.', 'hazard');
      return;
    }
    setStage('spraying');
    try {
      await updateCrewRoster(key.secret, crew.pubkey, {
        name: crew.tag ?? 'crew',
        members: [...members.map((m) => m.pubkey), writer.pubkey],
        founderPubkey: crew.founderPubkey ?? undefined,
        foundedAt: crew.foundedAt ?? undefined,
      }, { onStage: setStage });
      const nextMembers = [...members, writer];
      setPage({
        ...page,
        crew: { ...crew, memberCount: nextMembers.length },
        members: nextMembers,
        repping: repping.filter((r) => r.pubkey !== writer.pubkey),
      });
      say(`${writer.tag || 'That writer'} is on.`);
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      setStage(null);
    }
  };

  return (
    <div className="shell shell--wide pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}
      <div className="row" style={{ gap: 14 }}>
        <Identicon pubkey={pubkey} size={64} />
        <div style={{ minWidth: 0 }}>
          <h2>{crew.tag || 'unnamed crew'}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {fingerprint(pubkey)}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          {crew.verified ? <p className="kicker" style={{ color: 'var(--sodium)' }}>verified</p> : null}
          {crew.bio ? <p className="bio" style={{ marginTop: 8 }}>{crew.bio}</p> : null}
          {crew.founderPubkey ? (
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: 4 }}>
              founded by{' '}
              <Link to={`/w/${crew.founderPubkey}`} style={{ textDecoration: 'underline' }}>
                {founderName || fingerprint(crew.founderPubkey)}
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
          {!isFounder ? (
            <Link to="/crew/import" className="kicker" style={{ alignSelf: 'center', textDecoration: 'underline' }}>
              Hold this crew&apos;s blackbook? Bring it in.
            </Link>
          ) : null}
        </div>
      ) : null}

      {isFounder ? (
        <FounderPanel
          crew={crew}
          members={members}
          onRosterChange={async (next) => {
            setPage({ ...page, crew: { ...crew, memberCount: next.length }, members: next });
          }}
          onCrewInfoChange={async (info) => {
            setPage({ ...page, crew: { ...crew, tag: info.name, bio: info.bio } });
          }}
          onStage={setStage}
          stage={stage}
        />
      ) : null}

      <hr className="rule" />

      <section className="stack">
        <h3>Roster ({members.length})</h3>
        {members.length === 0 ? (
          <p className="muted">No one on the signed roster yet.</p>
        ) : (
          <div className="chips" style={{ gap: 10 }}>
            {members.map((m) => (
              <FounderRosterRow
                key={m.pubkey}
                member={m}
                isFounder={isFounder}
                onRemove={() => void removeMember(m.pubkey)}
              />
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
              <div key={m.pubkey} className="writer" style={{ gap: 8 }}>
                <Link to={`/w/${m.pubkey}`} className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
                  <Identicon pubkey={m.pubkey} size={22} />
                  <span className="writer__name">{m.tag || 'unnamed'}</span>
                  <span className="writer__mark">{m.mark}</span>
                </Link>
                {isFounder ? (
                  <button
                    type="button"
                    className="btn btn--go btn--sm sticker"
                    style={{ marginLeft: 4 }}
                    disabled={stage !== null}
                    onClick={() => void putOnRoster(m)}
                  >
                    Put on the roster
                  </button>
                ) : null}
              </div>
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

// ---------------------------------------------------------------------------
// Founder-only roster management — every change is signed by the crew key.
// ---------------------------------------------------------------------------

interface FounderRosterRowProps {
  member: CrewMember;
  isFounder: boolean;
  onRemove: () => void;
}

function FounderRosterRow({ member, isFounder, onRemove }: FounderRosterRowProps): JSX.Element {
  return (
    <Link to={`/w/${member.pubkey}`} className="writer" style={{ gap: 8 }}>
      <Identicon pubkey={member.pubkey} size={22} />
      <span className="writer__name">{member.tag || 'unnamed'}</span>
      <span className="writer__mark">{member.mark}</span>
      {isFounder ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label={`Buff ${member.tag || 'this writer'} off the roster`}
          style={{ marginLeft: 4 }}
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          ×
        </button>
      ) : null}
    </Link>
  );
}

interface FounderPanelProps {
  crew: CrewPage['crew'];
  members: CrewMember[];
  onRosterChange: (next: CrewMember[]) => Promise<void>;
  onCrewInfoChange: (info: { name: string; bio: string | null }) => Promise<void>;
  onStage: (stage: Stage | null) => void;
  stage: Stage | null;
}

function FounderPanel({ crew, members, onRosterChange, onCrewInfoChange, onStage, stage }: FounderPanelProps): JSX.Element {
  const { say } = useToast();

  // Put someone on.
  const [addInput, setAddInput] = useState('');
  const [addResolved, setAddResolved] = useState<{ pubkey: string; name: string | null; mark: string } | null>(null);
  const [addError, setAddError] = useState('');

  // Edit crew info.
  const [editName, setEditName] = useState(crew.tag ?? '');
  const [editBio, setEditBio] = useState(crew.bio ?? '');
  const [editing, setEditing] = useState(false);

  const rosterPubkeys = members.map((m) => m.pubkey);

  const resolve = async (): Promise<void> => {
    const id = resolveWriterInput(addInput);
    if (!id) {
      setAddResolved(null);
      setAddError('That is not a writer. Paste their link or tag id.');
      return;
    }
    if (rosterPubkeys.includes(id)) {
      setAddResolved(null);
      setAddError('Already on the roster.');
      return;
    }
    setAddError('');
    const meta = await fetchProfile(id).catch(() => null);
    setAddResolved({ pubkey: id, name: meta?.name?.trim() || null, mark: fingerprint(id) });
  };

  const confirmAdd = async (): Promise<void> => {
    if (!addResolved) return;
    const key = await getCrewKey(crew.pubkey);
    if (!key) {
      say('You do not hold this crew on this device.', 'hazard');
      return;
    }
    onStage('spraying');
    try {
      await updateCrewRoster(key.secret, crew.pubkey, {
        name: crew.tag ?? 'crew',
        members: [...rosterPubkeys, addResolved.pubkey],
        founderPubkey: crew.founderPubkey ?? undefined,
        foundedAt: crew.foundedAt ?? undefined,
      }, { onStage });
      await onRosterChange([
        ...members,
        { pubkey: addResolved.pubkey, tag: addResolved.name, mark: addResolved.mark, avatarSha256: null },
      ]);
      setAddInput('');
      setAddResolved(null);
      say(`${addResolved.name || 'That writer'} is on.`);
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      onStage(null);
    }
  };

  const saveInfo = async (): Promise<void> => {
    const name = editName.trim();
    if (!name) {
      say('Pick a crew name first.', 'hazard');
      return;
    }
    const key = await getCrewKey(crew.pubkey);
    if (!key) {
      say('You do not hold this crew on this device.', 'hazard');
      return;
    }
    onStage('spraying');
    try {
      const bio = editBio.trim();
      await publishCrewProfile(key.secret, crew.pubkey, { name, bio }, { onStage });
      await onCrewInfoChange({ name, bio: bio || null });
      setEditing(false);
      say('Up.');
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
    } finally {
      onStage(null);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="kicker">{COPY.putOn.label}</span>
        <span className="help" style={{ margin: 0 }}>anyone holding the crew</span>
      </div>
      <p className="help" style={{ marginTop: 6 }}>
        You run this crew because this device holds its blackbook. Hand that
        blackbook to a writer you trust (they bring it in from their Crew page)
        and they run it too — same roster, same say. Take it back by buffing
        them off; there is no owner here, only who holds the book.
      </p>

      {/* Put someone on */}
      <div style={{ marginTop: 10 }}>
        <p className="help" style={{ marginTop: 0 }}>Paste a writer&apos;s link or tag id to put them on.</p>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            placeholder="https://1nky.com/w/…  or  /w/…  or tag id"
            disabled={stage !== null}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void resolve()} disabled={stage !== null}>
            Look up
          </button>
        </div>
        {addError ? <p className="error" style={{ marginTop: 4 }}>{addError}</p> : null}

        {addResolved ? (
          <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
            <Identicon pubkey={addResolved.pubkey} size={36} />
            <div style={{ minWidth: 0 }}>
              <span className="writer__name">{addResolved.name || 'unnamed'}</span>{' '}
              <span className="writer__mark">{addResolved.mark}</span>
              <p className="help" style={{ margin: 0 }}>Same mark as on their wall? Put them on.</p>
            </div>
            <button type="button" className="btn btn--go btn--sm sticker" onClick={() => void confirmAdd()} disabled={stage !== null}>
              {COPY.putOn.action}
            </button>
          </div>
        ) : null}
      </div>

      <hr className="rule" style={{ margin: '12px 0' }} />

      {/* Edit crew info */}
      {editing ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="field">
            <label htmlFor="crew-edit-name">Crew name</label>
            <input
              id="crew-edit-name"
              className="input input--display"
              value={editName}
              onChange={(e) => setEditName(e.target.value.slice(0, 24))}
              disabled={stage !== null}
            />
          </div>
          <div className="field">
            <label htmlFor="crew-edit-bio">What the crew is about</label>
            <textarea
              id="crew-edit-bio"
              className="textarea"
              value={editBio}
              onChange={(e) => setEditBio(e.target.value.slice(0, PROFILE_BIO_MAX))}
              placeholder="A line or two about the crew."
              disabled={stage !== null}
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn--go btn--sm sticker" onClick={() => void saveInfo()} disabled={stage !== null}>
              Put it up
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(false); setEditName(crew.tag ?? ''); setEditBio(crew.bio ?? ''); }} disabled={stage !== null}>
              Never mind
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(true); setEditName(crew.tag ?? ''); setEditBio(crew.bio ?? ''); }}>
          Edit crew info
        </button>
      )}
    </div>
  );
}

// The roster <X> handler is wired here (FounderPanel renders rows via the parent
// so the row reloads from state). Kept in the parent to mutate `members`.