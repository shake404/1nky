import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AgeDots } from '../components/AgeDots.js';
import { Avatar } from '../components/Avatar.js';
import { FlickCard } from '../components/FlickCard.js';
import { Identicon } from '../components/Identicon.js';
import { IgnoreWriter, useIgnoredWriters } from '../components/IgnoreWriter.js';
import { fetchWriterCrews, fetchCrewNames } from '../lib/crews.js';
import { fetchWriterPage, type Flick, type WriterSummary } from '../lib/feed.js';
import { fetchProfile } from '../lib/profiles.js';
import { onTheWallSince, upLine } from '../lib/reputation.js';
import { useTag } from '../state/TagProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * How long they have been on the wall and how much they have up — the only two
 * things this app will ever say about somebody's standing. No score, no rank,
 * nothing anybody can farm. Renders nothing at all when the wall does not know:
 * an invented "new here" is a guess wearing a fact's clothes.
 */
function Standing({ writer }: { writer: WriterSummary | null }): JSX.Element | null {
  if (!writer) return null;
  const since = onTheWallSince(writer.firstSeen);
  // What they have UP is the flick count; the wider count of everything they
  // have ever put up stands in when the wall only kept that one.
  const up = upLine(writer.flickCount ?? writer.postCount);
  if (!since && !up) return null;

  return (
    <p className="standing" style={{ marginTop: 8 }}>
      <AgeDots firstSeen={writer.firstSeen} />
      <span className="mono faint">{[since, up].filter(Boolean).join(' · ')}</span>
    </p>
  );
}

/**
 * "put on" — a writer already on here vouched for them.
 *
 * Stated once, quietly, next to the standing. It is not a rank and there is
 * nothing to collect: either somebody put them on or the wall says nothing.
 */
function PutOn({ writer }: { writer: WriterSummary | null }): JSX.Element | null {
  if (!writer?.putOn) return null;
  return <span className="put-on-chip">put on</span>;
}

/**
 * The crews a writer is repping, by NAME. Each crew's name comes off its own
 * kind-0; a crew we cannot read yet falls back to its mark rather than showing
 * a bare id. A claim, not a roster — the crew page is where the line-up is
 * confirmed, so the copy underneath says so.
 */
function ReppedCrews({ pubkeys }: { pubkeys: readonly string[] }): JSX.Element | null {
  const [names, setNames] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    if (pubkeys.length === 0) return;
    let live = true;
    void fetchCrewNames(pubkeys).then((found) => {
      if (live) setNames(found);
    });
    return () => {
      live = false;
    };
  }, [pubkeys]);

  if (pubkeys.length === 0) return null;

  return (
    <section className="stack" style={{ gap: 8 }}>
      <span className="kicker">Reppin&apos;</span>
      <div className="chips" style={{ gap: 8 }}>
        {pubkeys.map((crewPubkey) => (
          <Link key={crewPubkey} to={`/crew/${crewPubkey}`} className="chip">
            <Identicon pubkey={crewPubkey} size={16} />
            <span>{names.get(crewPubkey) || fingerprint(crewPubkey)}</span>
          </Link>
        ))}
      </div>
      <p className="help" style={{ fontSize: '0.78rem' }}>
        A claim, not a roster — crews confirm their own line-up on their crew page.
      </p>
    </section>
  );
}

/** A writer's page: tag, mark, identicon, everything they have up. */
export function Writer(): JSX.Element {
  const { pubkey = '' } = useParams();
  const { tag } = useTag();
  const [name, setName] = useState<string>('');
  const [bio, setBio] = useState<string>('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [summary, setSummary] = useState<WriterSummary | null>(null);
  const [crews, setCrews] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const ignored = useIgnoredWriters();

  const valid = HEX64.test(pubkey);
  const isMe = tag?.pubkey === pubkey;
  const hidden = !isMe && ignored.includes(pubkey.toLowerCase());

  // Crews a writer is repping — a self-declared claim, not a verified roster.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    void fetchWriterCrews(pubkey).then((found) => {
      if (live) setCrews(found);
    });
    return () => {
      live = false;
    };
  }, [pubkey, valid]);

  // One read for both halves of the page: who the wall says they are, and
  // everything they have up.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    setLoading(true);
    void fetchWriterPage(pubkey).then((page) => {
      if (live) {
        setFlicks(page.flicks);
        setSummary(page.writer);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [pubkey, valid]);

  // The tag name and bio live in the writer's own profile event.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    if (isMe && tag) {
      setName(tag.name);
      void fetchProfile(tag.pubkey).then((meta) => {
        if (!live) return;
        setBio(meta?.bio ?? '');
        setAvatar(meta?.avatarSha256 ?? null);
      });
      return () => {
        live = false;
      };
    }
    void fetchProfile(pubkey).then((meta) => {
      if (!live || !meta) return;
      setName(meta.name?.trim() || '');
      setBio(meta.bio ?? '');
      setAvatar(meta.avatarSha256 ?? null);
    });
    return () => {
      live = false;
    };
  }, [pubkey, valid, isMe, tag]);

  if (!valid) {
    return (
      <div className="shell empty">
        <h2>No such writer.</h2>
      </div>
    );
  }

  return (
    <div className="shell pad stack stack--wide">
      <div className="row" style={{ gap: 14 }}>
        <Avatar pubkey={pubkey} avatarSha256={avatar ?? summary?.avatarSha256} size={64} alt={name || summary?.tag || ''} />
        <div>
          <h2>{name || summary?.tag || 'unnamed'}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {fingerprint(pubkey)}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          <Standing writer={summary} />
          <PutOn writer={summary} />
          {bio ? <p className="bio">{bio}</p> : null}
        </div>
      </div>

      <ReppedCrews pubkeys={crews} />

      {isMe ? (
        <Link to="/profile/edit" className="btn btn--ghost btn--sm sticker">
          Edit your tag
        </Link>
      ) : (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Link to={`/messages/${pubkey}`} className="btn btn--go btn--sm sticker">
            Send a message
          </Link>
          <IgnoreWriter pubkey={pubkey} look="button" />
        </div>
      )}

      <hr className="rule" />

      {hidden ? (
        <div className="empty">
          <h2>You are ignoring them.</h2>
          <p className="muted">Their stuff stays off your wall until you say otherwise.</p>
        </div>
      ) : loading ? (
        <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
          loading
        </p>
      ) : flicks.length === 0 ? (
        <div className="empty">
          <h2>{COPY.flick.empty}</h2>
          {isMe ? <p className="muted">Yours would look good here.</p> : null}
        </div>
      ) : (
        <div className="wall">
          {flicks.map((flick) => (
            <FlickCard key={flick.id} flick={{ ...flick, writer: name }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** `/me` — the same page, pointed at whoever is holding this device. */
export function MyWall(): JSX.Element {
  const { tag } = useTag();
  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [summary, setSummary] = useState<WriterSummary | null>(null);
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [crews, setCrews] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void fetchWriterPage(tag.pubkey).then((page) => {
      if (live) {
        setFlicks(page.flicks);
        setSummary(page.writer);
        setLoading(false);
      }
    });
    void fetchProfile(tag.pubkey).then((meta) => {
      if (!live) return;
      setBio(meta?.bio ?? '');
      setAvatar(meta?.avatarSha256 ?? null);
    });
    void fetchWriterCrews(tag.pubkey).then((found) => {
      if (live) setCrews(found);
    });
    return () => {
      live = false;
    };
  }, [tag]);

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      <div className="row" style={{ gap: 14 }}>
        <Avatar pubkey={tag.pubkey} avatarSha256={avatar ?? summary?.avatarSha256} size={64} alt={tag.name} />
        <div>
          <h2>{tag.name}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {tag.mark}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          <Standing writer={summary} />
          <PutOn writer={summary} />
          {bio ? <p className="bio">{bio}</p> : null}
        </div>
      </div>

      <ReppedCrews pubkeys={crews} />

      <Link to="/profile/edit" className="btn btn--ghost btn--sm sticker">
        Edit your tag
      </Link>

      <hr className="rule" />

      {loading ? (
        <p className="kicker" style={{ textAlign: 'center', padding: 24 }}>
          loading
        </p>
      ) : flicks.length === 0 ? (
        <div className="empty">
          <h2>{COPY.flick.empty}</h2>
          <p className="muted">Nothing up yet.</p>
        </div>
      ) : (
        <div className="wall">
          {flicks.map((flick) => (
            <FlickCard key={flick.id} flick={{ ...flick, writer: tag.name }} />
          ))}
        </div>
      )}
    </div>
  );
}
