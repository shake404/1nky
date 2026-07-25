import { COPY, GRAF_TYPES, SURFACES, type GrafType, type Surface } from '@1nky/protocol';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { BlurFaces } from '../components/BlurFaces.js';
import { Spraying } from '../components/Spraying.js';
import { fetchExploreFacets, type FacetOption } from '../lib/explore.js';
import { postFlick, postVideo, type Stage } from '../lib/publish.js';
import { probeVideo } from '../lib/flicks.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

type Media = 'image' | 'video' | null;

/**
 * `/post` — put a flick OR a clip up.
 *
 * The pick gate reads a video's duration off a detached `<video>` element
 * BEFORE any bytes leave the device and refuses >60s (and over the size
 * ceiling), so nobody wastes an upload or work. Facet selectors tag the post
 * with a where / what / surface / region and an opt-in "had permission" toggle
 * — which is the ONLY legal facet exposed (never an illegal/bombing tag, per
 * the design doc's OPSEC rule Part 3.2).
 */
export function PostFlick(): JSX.Element {
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [media, setMedia] = useState<Media>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [alt, setAlt] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  // Face blur: the bytes the writer approved, and whether they asked for a
  // covering we could not give them.
  const [blurred, setBlurred] = useState<Blob | null>(null);
  const [blurBlocked, setBlurBlocked] = useState(false);

  // Facets.
  const [cities, setCities] = useState<FacetOption[]>([]);
  const [city, setCity] = useState('');
  const [typeSet, setTypeSet] = useState<Set<GrafType>>(new Set());
  const [surfaceSet, setSurfaceSet] = useState<Set<Surface>>(new Set());
  const [region, setRegion] = useState('');
  const [legal, setLegal] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchExploreFacets().then((facets) => {
      if (live) setCities(facets.cities);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      setMedia(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setMedia(file.type.startsWith('video/') ? 'video' : 'image');
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const chosen = event.target.files?.[0] ?? null;
    setError('');
    if (chosen && chosen.type.startsWith('video/')) {
      try {
        await probeVideo(chosen);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : 'Could not read that clip.');
        event.target.value = '';
        return;
      }
    }
    setFile(chosen);
  };

  // Stable identities: BlurFaces repaints whenever these change.
  const takeBlurred = useCallback((blob: Blob | null) => setBlurred(blob), []);
  const takeBlocked = useCallback((blocked: boolean) => setBlurBlocked(blocked), []);

  const submit = async (): Promise<void> => {
    if (!tag || !file || blurBlocked) return;
    setError('');
    setStage('preparing');
    try {
      const boards = city.trim() ? [city.trim()] : [];
      const facetDetails = {
        ...(boards.length ? { boards } : {}),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(typeSet.size ? { types: [...typeSet] } : {}),
        ...(surfaceSet.size ? { surfaces: [...surfaceSet] } : {}),
        ...(legal ? { legalPermission: true } : {}),
      };
      const details = {
        ...(caption.trim() ? { caption: caption.trim() } : {}),
        ...(alt.trim() ? { alt: alt.trim() } : {}),
        ...facetDetails,
      };
      if (media === 'video') {
        await postVideo(tag, { file, ...details, onStage: setStage });
      } else {
        // The covered canvas replaces the picked file when the writer asked for
        // it, so the blur happens BEFORE the upload pipeline's own strip-and-
        // re-encode rather than after — the original bytes never go anywhere.
        const going = blurred
          ? new File([blurred], file.name.replace(/\.[^.]+$/, '') + '.webp', {
              type: 'image/webp',
            })
          : file;
        await postFlick(tag, { file: going, ...details, onStage: setStage });
      }
      say('Up.');
      navigate('/', { replace: true });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go up. Try again.');
      setStage(null);
    }
  };

  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void): void => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const accept = 'image/*,video/*';

  return (
    <div className="shell shell--wide pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">put it up</span>
        <h2 style={{ marginTop: 12 }}>{COPY.flick.action}</h2>
      </div>

      <input
        ref={input}
        className="sr-only"
        type="file"
        accept={accept}
        onChange={(e) => void pick(e)}
        aria-label="Choose a picture or clip"
      />

      {preview ? (
        <button type="button" onClick={() => input.current?.click()} style={{ display: 'block', width: '100%' }}>
          {media === 'video' ? (
            <video className="preview" src={preview} controls playsInline preload="metadata" />
          ) : (
            <img className="preview" src={preview} alt="" />
          )}
        </button>
      ) : (
        <button type="button" className="drop" onClick={() => input.current?.click()}>
          <span className="display" style={{ fontSize: '1.6rem' }}>
            Choose a picture or clip
          </span>
          <span className="muted" style={{ fontSize: '0.9rem' }}>
            Pictures and 60-second clips. Location and camera details get stripped on this device
            before anything goes anywhere.
          </span>
        </button>
      )}

      {error ? <p className="error">{error}</p> : null}

      <BlurFaces file={media === 'image' ? file : null} onBlurred={takeBlurred} onBlocked={takeBlocked} />

      {/* Facet selectors — tag this post so Explore can find it. */}
      <section className="facets">
        <div className="facet-group">
          <span className="facet-group__label">Where</span>
          <input
            className="input"
            value={city}
            onChange={(e) => setCity(e.target.value.slice(0, 32))}
            placeholder="City slug, e.g. sf-bay"
            list="city-suggestions"
          />
          <datalist id="city-suggestions">
            {cities.map((c) => (
              <option key={c.slug} value={c.slug} />
            ))}
          </datalist>
          <p className="help">City-granularity only — never a spot. Leave blank to post to the whole wall.</p>
        </div>

        <div className="facet-group">
          <span className="facet-group__label">What</span>
          <div className="chips">
            {GRAF_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${typeSet.has(t) ? 'chip--active' : ''}`}
                onClick={() => toggle(typeSet, t, setTypeSet)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="facet-group">
          <span className="facet-group__label">Surface</span>
          <div className="chips">
            {SURFACES.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip ${surfaceSet.has(s) ? 'chip--active' : ''}`}
                onClick={() => toggle(surfaceSet, s, setSurfaceSet)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="facet-group">
          <span className="facet-group__label">Region (optional)</span>
          <input
            className="input"
            value={region}
            onChange={(e) => setRegion(e.target.value.slice(0, 32))}
            placeholder="e.g. bay-area"
          />
        </div>

        <label className={`toggle ${legal ? 'toggle--on' : ''}`}>
          <span className="toggle__box" aria-hidden="true" />
          <input
            type="checkbox"
            className="sr-only"
            checked={legal}
            onChange={(e) => setLegal(e.target.checked)}
          />
          had permission
        </label>
        <p className="help">Only the positive tag is ever offered — &ldquo;not legal&rdquo; is just saying nothing.</p>
      </section>

      <div className="field">
        <label htmlFor="caption">Caption</label>
        <textarea
          id="caption"
          className="textarea"
          value={caption}
          onChange={(event) => setCaption(event.target.value.slice(0, 500))}
          placeholder="Optional"
        />
      </div>

      <div className="field">
        <label htmlFor="alt">Describe it</label>
        <input
          id="alt"
          className="input"
          value={alt}
          onChange={(event) => setAlt(event.target.value.slice(0, 200))}
          placeholder="Optional — for anyone who can't see it"
        />
      </div>

      <button
        type="button"
        className="btn btn--go btn--block sticker"
        onClick={() => void submit()}
        disabled={!file || stage !== null || blurBlocked}
      >
        Put it up
      </button>
      {blurBlocked ? (
        <p className="help hazard">
          You asked for faces to be covered and that did not work here. Switch it off above if you
          want to put this up as it is.
        </p>
      ) : null}
    </div>
  );
}