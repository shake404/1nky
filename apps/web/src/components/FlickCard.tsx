import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Flick } from '../lib/feed.js';
import { ago } from '../lib/platform.js';
import { WriterChip } from './WriterChip.js';

/** One tile on the wall. */
export function FlickCard({ flick }: { flick: Flick }): JSX.Element {
  const [revealed, setRevealed] = useState(!flick.contentWarning);
  const ratio = flick.width > 0 && flick.height > 0 ? `${flick.width} / ${flick.height}` : '3 / 4';

  return (
    <article className="flick">
      <Link to={`/f/${flick.id}`} aria-label={flick.alt ?? flick.caption ?? 'flick'}>
        <img
          src={flick.url}
          alt={flick.alt ?? flick.caption ?? ''}
          loading="lazy"
          decoding="async"
          width={flick.width}
          height={flick.height}
          style={{ aspectRatio: ratio }}
        />
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
