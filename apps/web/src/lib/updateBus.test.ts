import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceUpdate, onUpdateAvailable, resetUpdateBusForTests } from './updateBus.js';

/**
 * `registerSW` fires its `onNeedRefresh` callback before React has mounted
 * anything, so this bus has to hold onto that announcement until a
 * component shows up to hear it — and also fan it out to any subscriber
 * already listening.
 */

afterEach(() => {
  resetUpdateBusForTests();
});

describe('updateBus', () => {
  it('tells an already-subscribed listener about a new announcement', () => {
    const listener = vi.fn();
    onUpdateAvailable(listener);

    const apply = vi.fn();
    announceUpdate(apply);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(apply);
  });

  it('replays the pending announcement to a listener that subscribes late', () => {
    const apply = vi.fn();
    announceUpdate(apply);

    const listener = vi.fn();
    onUpdateAvailable(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(apply);
  });

  it('says nothing to a listener when no build has been announced', () => {
    const listener = vi.fn();
    onUpdateAvailable(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops calling a listener once it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = onUpdateAvailable(listener);
    unsubscribe();

    announceUpdate(vi.fn());

    expect(listener).not.toHaveBeenCalled();
  });

  it('replaces the pending update when a second build lands before the first is applied', () => {
    const first = vi.fn();
    const second = vi.fn();
    announceUpdate(first);
    announceUpdate(second);

    const listener = vi.fn();
    onUpdateAvailable(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(second);
  });

  it('notifies every current subscriber, not just the first', () => {
    const a = vi.fn();
    const b = vi.fn();
    onUpdateAvailable(a);
    onUpdateAvailable(b);

    const apply = vi.fn();
    announceUpdate(apply);

    expect(a).toHaveBeenCalledWith(apply);
    expect(b).toHaveBeenCalledWith(apply);
  });
});
