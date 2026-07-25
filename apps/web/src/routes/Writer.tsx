import { COPY, fingerprint } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlickCard } from '../components/FlickCard.js';
import { Identicon } from '../components/Identicon.js';
import { fetchWriterFlicks, type Flick } from '../lib/feed.js';
import { fetchProfile } from '../lib/profiles.js';
import { useTag } from '../state/TagProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** A writer's page: tag, mark, identicon, everything they have up. */
export function Writer(): JSX.Element {
  const { pubkey = '' } = useParams();
  const { tag } = useTag();
  const [name, setName] = useState<string>('');
  const [bio, setBio] = useState<string>('');
  const [flicks, setFlicks] = useState<Flick[]>([]);
  const [loading, setLoading] = useState(true);

  const valid = HEX64.test(pubkey);
  const isMe = tag?.pubkey === pubkey;

  useEffect(() => {
    if (!valid) return;
    let live = true;
    setLoading(true);
    void fetchWriterFlicks(pubkey).then((found) => {
      if (live) {
        setFlicks(found);
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
        if (live) setBio(meta?.bio ?? '');
      });
      return () => {
        live = false;
      };
    }
    void fetchProfile(pubkey).then((meta) => {
      if (!live || !meta) return;
      setName(meta.name?.trim() || '');
      setBio(meta.bio ?? '');
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
        <Identicon pubkey={pubkey} size={64} />
        <div>
          <h2>{name || 'unnamed'}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {fingerprint(pubkey)}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          {bio ? <p className="bio">{bio}</p> : null}
        </div>
      </div>

      {isMe ? (
        <Link to="/profile/edit" className="btn btn--ghost btn--sm sticker">
          Edit your tag
        </Link>
      ) : (
        <Link to={`/messages/${pubkey}`} className="btn btn--go btn--sm sticker">
          Send a message
        </Link>
      )}

      <hr className="rule" />

      {loading ? (
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
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void fetchWriterFlicks(tag.pubkey).then((found) => {
      if (live) {
        setFlicks(found);
        setLoading(false);
      }
    });
    void fetchProfile(tag.pubkey).then((meta) => {
      if (live) setBio(meta?.bio ?? '');
    });
    return () => {
      live = false;
    };
  }, [tag]);

  if (!tag) return <div className="shell empty" />;

  return (
    <div className="shell pad stack stack--wide">
      <div className="row" style={{ gap: 14 }}>
        <Identicon pubkey={tag.pubkey} size={64} />
        <div>
          <h2>{tag.name}</h2>
          <p className="mono muted" style={{ marginTop: 4 }}>
            {tag.mark}
          </p>
          <p className="help">{COPY.mark.hint}</p>
          {bio ? <p className="bio">{bio}</p> : null}
        </div>
      </div>

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
