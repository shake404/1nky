/**
 * Bridges the service-worker update lifecycle into React.
 *
 * `registerSW` (from `virtual:pwa-register`) is called once, from main.tsx,
 * before anything renders — so when it learns a new build is waiting, there
 * is no component tree yet to hand that news to. This is the module-level
 * mailbox in between: `announceUpdate` is called from the registration
 * bridge (see registerAppUpdates.ts), and any number of React subscribers
 * can pick it up later with `onUpdateAvailable`, including ones that mount
 * after the announcement already happened.
 *
 * Kept dependency-free (no React, no `virtual:pwa-register`) so it can be
 * unit-tested directly.
 */

/** Call this to swap in the waiting build and reload. */
export type ApplyUpdate = () => void;

type Listener = (apply: ApplyUpdate) => void;

let listeners: Listener[] = [];
let pending: ApplyUpdate | null = null;

/**
 * Records that a new build is installed and waiting, and tells every current
 * subscriber how to activate it. Safe to call more than once (e.g. a second
 * build lands before the first was applied) — later calls simply replace
 * what "apply" does.
 */
export function announceUpdate(apply: ApplyUpdate): void {
  pending = apply;
  for (const listener of listeners) listener(apply);
}

/**
 * Subscribes to update announcements. If a build was already announced
 * before this call, the listener fires immediately with it — so a component
 * mounted after the fact never misses the news. Returns an unsubscribe
 * function.
 */
export function onUpdateAvailable(listener: Listener): () => void {
  listeners = [...listeners, listener];
  if (pending) listener(pending);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/** Test-only: clears all subscribers and the pending announcement. */
export function resetUpdateBusForTests(): void {
  listeners = [];
  pending = null;
}
