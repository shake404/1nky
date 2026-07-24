import { COPY } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import type { Stage } from '../lib/publish.js';

const LABELS: Record<Stage, string> = {
  preparing: 'Cleaning it up...',
  uploading: 'Sending it...',
  spraying: COPY.spraying.label,
  posting: 'Putting it up...',
  done: 'Up.',
};

/**
 * Full-screen wait state.
 *
 * The long pause here is proof-of-work grinding in the miner worker, but a
 * writer never needs to know that — it is just how long a can takes.
 */
export function Spraying({ stage }: { stage: Stage }): JSX.Element {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, [stage]);

  const label = stage === 'spraying' && slow ? COPY.spraying.slow : LABELS[stage];

  return (
    <div className="spray" role="status" aria-live="polite">
      <div className="spray__can" />
      <div className="spray__mist">
        <i />
        <i />
        <i />
        <i />
      </div>
      <p className="display" style={{ fontSize: '1.6rem' }}>
        {label}
      </p>
      <p className="faint mono">hold tight</p>
    </div>
  );
}
