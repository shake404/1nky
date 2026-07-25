import { fingerprint, PROFILE_BIO_MAX } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Identicon } from '../components/Identicon.js';
import { Spraying } from '../components/Spraying.js';
import { fetchWriterCrews } from '../lib/crews.js';
import { fetchProfile } from '../lib/profiles.js';
import { publishProfile, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `/profile/edit` — change your bio and which crews you are repping.
 *
 * Crews here are a CLAIM, not a roster: a writer can list any crew handle or
 * pubkey the way they can pick any tag name. The crew page is where the
 * crew-signed roster (and the badge) lives.
 */
export function ProfileEdit(): JSX.Element {
  const { tag, refresh } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();

  const [bio, setBio] = useState('');
  const [crews, setCrews] = useState<string[]>([]);
  const [crewInput, setCrewInput] = useState('');
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
    void fetchWriterCrews(tag.pubkey).then((found) => {
      if (live) setCrews(found);
    });
    return () => {
      live = false;
    };
  }, [tag]);

  if (!tag) return <div className="shell empty" />;

  const save = async (): Promise<void> => {
    setStage('spraying');
    try {
      await publishProfile(tag, { first: false, bio, crews, onStage: setStage });
      void refresh();
      say('Up.');
      navigate('/me', { replace: true });
    } catch (error) {
      say(error instanceof Error ? error.message : 'That did not go up.', 'hazard');
      setStage(null);
    }
  };

  const addCrew = (): void => {
    const value = crewInput.trim().toLowerCase();
    if (!value) return;
    if (!HEX64.test(value)) {
      say('A crew is a 64-character mark. Open a crew page and copy it.', 'hazard');
      return;
    }
    if (crews.includes(value)) {
      setCrewInput('');
      return;
    }
    setCrews([...crews, value]);
    setCrewInput('');
  };

  const removeCrew = (crew: string): void => {
    setCrews(crews.filter((c) => c !== crew));
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

      <hr className="rule" />

      <section className="stack">
        <h3>Reppin&apos;</h3>
        <p className="help" style={{ marginTop: 0 }}>
          A claim, not a membership card — crews confirm their own roster on their crew page.
        </p>

        {crews.length > 0 ? (
          <div className="chips" style={{ gap: 8 }}>
            {crews.map((crew) => (
              <span key={crew} className="filter-pill">
                <span className="mono" style={{ fontSize: '0.7rem' }}>{fingerprint(crew)}</span>
                <button type="button" aria-label="Remove crew" onClick={() => removeCrew(crew)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            value={crewInput}
            onChange={(e) => setCrewInput(e.target.value)}
            placeholder="Paste a crew mark (64-character)"
            disabled={stage !== null}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={addCrew} disabled={stage !== null}>
            Add
          </button>
        </div>
      </section>

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