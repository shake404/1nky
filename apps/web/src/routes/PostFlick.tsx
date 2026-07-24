import { COPY } from '@1nky/protocol';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spraying } from '../components/Spraying.js';
import { postFlick, type Stage } from '../lib/publish.js';
import { useTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/** Pick a picture, say a word, put it up. */
export function PostFlick(): JSX.Element {
  const { tag } = useTag();
  const { say } = useToast();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [alt, setAlt] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0] ?? null;
    setError('');
    setFile(chosen);
  };

  const submit = async (): Promise<void> => {
    if (!tag || !file) return;
    setError('');
    setStage('preparing');
    try {
      await postFlick(tag, {
        file,
        ...(caption.trim() ? { caption: caption.trim() } : {}),
        ...(alt.trim() ? { alt: alt.trim() } : {}),
        onStage: setStage,
      });
      say('Up.');
      navigate('/', { replace: true });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go up. Try again.');
      setStage(null);
    }
  };

  return (
    <div className="shell pad stack stack--wide">
      {stage ? <Spraying stage={stage} /> : null}

      <div>
        <span className="tape">put it up</span>
        <h2 style={{ marginTop: 12 }}>{COPY.flick.action}</h2>
      </div>

      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/*"
        onChange={pick}
        aria-label="Choose a picture"
      />

      {preview ? (
        <button type="button" onClick={() => input.current?.click()} style={{ display: 'block', width: '100%' }}>
          <img className="preview" src={preview} alt="" />
        </button>
      ) : (
        <button type="button" className="drop" onClick={() => input.current?.click()}>
          <span className="display" style={{ fontSize: '1.6rem' }}>
            Choose a picture
          </span>
          <span className="muted" style={{ fontSize: '0.9rem' }}>
            Location and camera details get stripped on this device before anything
            goes anywhere.
          </span>
        </button>
      )}

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

      {error ? <p className="error">{error}</p> : null}

      <button
        type="button"
        className="btn btn--go btn--block sticker"
        onClick={() => void submit()}
        disabled={!file || stage !== null}
      >
        Put it up
      </button>
    </div>
  );
}
