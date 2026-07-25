/**
 * Wait until the typing stops.
 *
 * Used by the search screen: a writer types "sf b" and we ask the wall once,
 * not four times. Deliberately tiny and dependency-free — the only thing it
 * knows how to do is hold the last call back and then let it through.
 */

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drop a call that is still waiting. Safe to call when nothing is pending. */
  cancel(): void;
  /** True while a call is being held back. */
  pending(): boolean;
}

/**
 * Hold `fn` back until `ms` has passed with no further calls. Only the LAST set
 * of arguments ever lands — an intermediate keystroke is not a query anybody
 * asked for.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let handle: ReturnType<typeof setTimeout> | undefined;

  const wrapped = ((...args: A): void => {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = undefined;
      fn(...args);
    }, ms);
  }) as Debounced<A>;

  wrapped.cancel = (): void => {
    if (handle === undefined) return;
    clearTimeout(handle);
    handle = undefined;
  };

  wrapped.pending = (): boolean => handle !== undefined;

  return wrapped;
}
