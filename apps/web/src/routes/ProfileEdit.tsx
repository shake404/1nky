import { fingerprint, PROFILE_BIO_MAX } from '@1nky/protocol';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { AvatarCropper } from '../components/AvatarCropper.js';
import { Spraying } from '../components/Spraying.js';
import { fetchWriterCrews } from '../lib/crews.js';
import { uploadBlob } from '../lib/flicks.js';
import { fetchProfile } from '../lib/profiles.js';
import { publishProfile, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `/profile/edit` — change your picture, your bio and which crews you are
 * repping.
 *
 * Crews here are a CLAIM, not a roster: a writer can list any crew handle or
 * pubkey the way they can pick any tag name. The crew page is where the
 * crew-signed roster (and the badge) lives.
 *
 * The picture reuses the flick pipeline exactly — {@link prepareImage} strips
 * every trace of metadata on-device (a canvas re-encode), {@link uploadBlob}
 * signs the upload with this tag's own secret. The address the server hands
 * back rides on the kind-0 as the writer's avatar; clearing it re-publishes the
 * tag with no picture at all.
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

  // The picture. `avatarSha256` is what is on the wall now; `picked` is the
  // freshly-framed square (a blob) that has not gone up yet; `preview` is its
  // object URL; `cropFile` is a just-picked file waiting to be framed (the
  // cropper is open while it is set).
  const [avatarSha256, setAvatarSha256] = useState<string | null>(null);
  const [picked, setPicked] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!tag) return;
    let live = true;
    void fetchProfile(tag.pubkey).then((meta) => {
      if (!live) return;
      setBio(meta?.bio ?? '');
      setAvatarSha256(meta?.avatarSha256 ?? null);
      setLoaded(true);
    });
    void fetchWriterCrews(tag.pubkey).then((found) => {
      if (live) setCrews(found);
    });
    return () => {
      live = false;
    };
  }, [tag]);

  // Never leak the object URL the preview was drawn from.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  if (!tag) return <div className="shell empty" />;

  /** A framed square came back from the cropper — hold it for upload on save. */
  const onCropped = (blob: Blob): void => {
    if (preview) URL.revokeObjectURL(preview);
    setPicked(blob);
    setPreview(URL.createObjectURL(blob));
    setCropFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const cancelCrop = (): void => {
    setCropFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const removePicture = (): void => {
    if (preview) URL.revokeObjectURL(preview);
    setPicked(null);
    setPreview(null);
    setAvatarSha256(null);
    setCropFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const save = async (): Promise<void> => {
    try {
      // A fresh pick goes up first, so the kind-0 can point at its address.
      // Otherwise keep whatever is there, or '' to clear it — publishProfile
      // drops an empty one from the tag entirely.
      let sha = avatarSha256 ?? '';
      if (picked) {
        setStage('uploading');
        const upload = await uploadBlob(picked, tag.secret);
        sha = upload.sha256;
      } else {
        setStage('spraying');
      }
      await publishProfile(tag, { first: false, bio, crews, avatarSha256: sha, onStage: setStage });
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
  const hasPicture = picked !== null || (avatarSha256 !== null && HEX64.test(avatarSha256));

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">your tag</span>
        <h2 style={{ marginTop: 12 }}>Edit your tag</h2>
      </div>

      <div className="row" style={{ gap: 14 }}>
        {picked && preview ? (
          <img className="avatar" src={preview} alt="" width={56} height={56} style={{ width: 56, height: 56 }} />
        ) : (
          <Avatar pubkey={tag.pubkey} avatarSha256={avatarSha256} size={56} alt={tag.name} />
        )}
        <div>
          <p className="display" style={{ fontSize: '1.5rem' }}>
            {tag.name}
          </p>
          <p className="mono muted">{fingerprint(tag.pubkey)}</p>
        </div>
      </div>

      <div className="field">
        {/* Never "face" — inviting a face photo is anti-opsec. A sticker
            (slap) is graffiti-native and explicitly not a selfie. */}
        <label htmlFor="avatar">Slap a sticker on it</label>
        {cropFile ? (
          <AvatarCropper file={cropFile} onDone={onCropped} onCancel={cancelCrop} />
        ) : (
          <>
            <input
              ref={fileInput}
              id="avatar"
              type="file"
              accept="image/*"
              disabled={!loaded || stage !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) setCropFile(file);
              }}
            />
            <p className="help muted">A picture for your tag. Optional — the block-mark stands in without one.</p>
            {hasPicture ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={removePicture} disabled={stage !== null}>
                Take it off
              </button>
            ) : null}
          </>
        )}
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
