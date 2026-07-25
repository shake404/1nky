import { fingerprint, PROFILE_BIO_MAX } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { Spraying } from '../components/Spraying.js';
import { fetchProfile } from '../lib/profiles.js';
import { publishProfile, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/** `/profile/edit` — change your bio. The tag name lives in Settings. */
export function ProfileEdit(): JSX.Element {
  const { tag, refresh } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [bio, setBio] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void fetchProfile(tag.pubkey).then((meta) => {
      if (!live) return;
      setBio(meta?.bio ?? '');
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [tag]);

  if (!tag) return <div className="shell empty" />;

  const save = async (): Promise<void> => {
    setStage('spraying');
    try {
      await publishProfile(tag, { first: false, bio, onStage: setStage });
      void refresh();
      say('Up.');
      navigate('/me', { replace: true });
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
      setStage(null);
    }
  };

  const remaining = PROFILE_BIO_MAX - bio.length;

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">your tag</span>
        <h2 style={{ marginTop: 12 }}>Edit your tag</h2>
      </div>

      <div className="row" style={{ gap: 14 }}>
        <Identicon pubkey={tag.pubkey} size={56} />
        <div>
          <p className="display" style={{ fontSize: '1.5rem' }}>
            {tag.name}
          </p>
          <p className="mono muted">{fingerprint(tag.pubkey)}</p>
        </div>
      </div>

      <hr className="rule" />

      <div className="field">
        <label htmlFor="bio">Bio</label>
        <textarea
          id="bio"
          className="textarea"
          value={bio}
          onChange={(event) => setBio(event.target.value.slice(0, PROFILE_BIO_MAX))}
          placeholder="Say something about yourself. Optional."
          disabled={!loaded || stage !== null}
        />
        <p className={`help ${remaining < 40 ? 'hazard' : 'muted'}`}>
          {remaining} characters left
        </p>
      </div>

      <button
        type="button"
        className="btn btn--go btn--block sticker"
        onClick={() => void save()}
        disabled={!loaded || stage !== null}
      >
        Put it up
      </button>
    </div>
  );
}
