import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Flick } from '../lib/feed.js';
import { ago } from '../lib/platform.js';
import { WriterChip } from './WriterChip.js';

/** One tile on the wall — a flick (picture) or a video clip. */
export function FlickCard({ flick }: { flick: Flick }): JSX.Element {
  const [revealed, setRevealed] = useState(!flick.contentWarning);
  const ratio = flick.width > 0 && flick.height > 0 ? `${flick.width} / ${flick.height}` : '3 / 4';

  return (
    <article className="flick">
      <Link to={`/f/${flick.id}`} aria-label={flick.alt ?? flick.caption ?? (flick.mediaType === 'video' ? 'clip' : 'flick')}>
        {flick.mediaType === 'video' && flick.posterUrl ? (
          <video
            src={flick.url}
            poster={flick.posterUrl}
            preload="none"
            playsInline
            controls
            muted
            width={flick.width}
            height={flick.height}
            style={{ aspectRatio: ratio }}
          />
        ) : (
          <img
            src={flick.url}
            alt={flick.alt ?? flick.caption ?? ''}
            loading="lazy"
            decoding="async"
            width={flick.width}
            height={flick.height}
            style={{ aspectRatio: ratio }}
          />
        )}
        {flick.mediaType === 'video' && typeof flick.duration === 'number' ? (
          <span className="flick__badge mono" aria-hidden="true">
            {durationLabel(flick.duration)}
          </span>
        ) : null}
      </Link>
      {revealed ? null : (
        <div className="flick__cw">
          <p className="kicker">heads up</p>
          <p className="muted">{flick.contentWarning}</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRevealed(true)}>
            Look anyway
          </button>
        </div>
      )}
      {flick.caption ? <p className="flick__caption">{flick.caption}</p> : null}
      <div className="flick__meta spread">
        <WriterChip pubkey={flick.pubkey} name={flick.writer} size={20} />
        <span className="mono faint">{ago(flick.createdAt)}</span>
      </div>
    </article>
  );
}

/** `1:23` style duration label for a video tile badge. */
export function durationLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}