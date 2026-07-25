import { AGE_DOT_MAX, wallAge } from '../lib/reputation.js';

/**
 * Three dots that fill in as somebody sticks around.
 *
 * The whole point is that it CANNOT be gamed and it is not a score: it says how
 * long they have been on the wall, nothing else. A fresh tag shows three empty
 * dots and there is no shortcut past that. Nothing renders at all when the wall
 * does not know — see `wallAge`.
 *
 * The dots are decoration for the eye; the sentence in `aria-label` is the real
 * content, which is why it is spelled out ("up for 3 months") rather than
 * read as "2 of 3".
 */
export function AgeDots({
  firstSeen,
  now,
}: {
  firstSeen: number | null | undefined;
  /** Test seam. Left alone, it is right now. */
  now?: number;
}): JSX.Element | null {
  const age = now === undefined ? wallAge(firstSeen) : wallAge(firstSeen, now);
  if (!age) return null;

  return (
    <span className="age-dots" role="img" aria-label={age.label} title={age.label}>
      {Array.from({ length: AGE_DOT_MAX }, (_, index) => (
        <i
          key={index}
          className={`age-dots__dot ${index < age.dots ? 'age-dots__dot--on' : ''}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
