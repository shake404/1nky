import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce.js';

/**
 * The search box asks the wall once the typing stops. What matters is that a
 * burst of keystrokes is ONE ask, that the ask carries the last thing typed
 * rather than the first, and that leaving the screen can take a pending ask
 * with it.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('does not run until the waiting is over', () => {
    const spy = vi.fn();
    const soon = debounce(spy, 200);

    soon('s');
    vi.advanceTimersByTime(199);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('turns a burst of typing into one call, carrying the last thing typed', () => {
    const spy = vi.fn();
    const soon = debounce(spy, 200);

    soon('s');
    vi.advanceTimersByTime(50);
    soon('sf');
    vi.advanceTimersByTime(50);
    soon('sf b');
    vi.advanceTimersByTime(200);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('sf b');
  });

  it('lets a second, separate ask through', () => {
    const spy = vi.fn();
    const soon = debounce(spy, 100);

    soon('one');
    vi.advanceTimersByTime(100);
    soon('two');
    vi.advanceTimersByTime(100);

    expect(spy.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('drops a pending call when it is cancelled', () => {
    const spy = vi.fn();
    const soon = debounce(spy, 100);

    soon('gone');
    expect(soon.pending()).toBe(true);
    soon.cancel();
    expect(soon.pending()).toBe(false);
    vi.advanceTimersByTime(1000);

    expect(spy).not.toHaveBeenCalled();
  });

  it('shrugs at a cancel with nothing to cancel', () => {
    const soon = debounce(vi.fn(), 100);
    expect(() => soon.cancel()).not.toThrow();
  });
});
