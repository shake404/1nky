import type { BeefClock } from '../lib/boards.js';

/**
 * The countdown sticker on a beef thread.
 *
 * Quiet while there is time left, ink once it is nearly gone — ink is reserved
 * for the live and the irreversible, and a thread about to disappear is exactly
 * that.
 */
export function BeefChip({ clock }: { clock: BeefClock }): JSX.Element {
  return (
    <span className={`beef-clock mono ${clock.urgent || clock.gone ? 'beef-clock--hot' : ''}`}>
      {clock.text}
    </span>
  );
}
