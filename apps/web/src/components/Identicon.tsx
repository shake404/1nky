import { useEffect, useRef } from 'react';
import { drawIdenticon } from '../lib/identicon.js';

/** The little block-mark that sits next to every tag name. */
export function Identicon({ pubkey, size = 22 }: { pubkey: string; size?: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) drawIdenticon(ref.current, pubkey, size);
  }, [pubkey, size]);

  return <canvas ref={ref} className="identicon" aria-hidden="true" />;
}
