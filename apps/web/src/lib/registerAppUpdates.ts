import { registerSW } from 'virtual:pwa-register';
import { announceUpdate } from './updateBus.js';

/**
 * How a stale phone finds out a new build exists.
 *
 * The plugin is configured with `registerType: 'prompt'` (see vite.config.ts)
 * rather than `autoUpdate`: autoUpdate would have workbox silently swap the
 * service worker and force a reload the moment a build lands, which can land
 * mid-upload or mid-post. Prompt mode instead installs the new build in the
 * background and waits — `onNeedRefresh` fires once it is ready, we hand the
 * reload trigger to `updateBus`, and a writer taps the toast on their own
 * schedule instead of losing the tab out from under them.
 *
 * A writer who leaves the PWA open for hours (it is a wall they check
 * between walks) would otherwise never see that toast, since nothing else
 * asks the browser to look for a new build. So this also polls: every hour,
 * and every time the tab comes back into view.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function registerAppUpdates(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      announceUpdate(() => {
        void updateSW(true);
      });
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;

      const recheck = (): void => {
        void registration.update().catch(() => {
          /* offline or relay unreachable — try again next tick */
        });
      };

      setInterval(recheck, CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') recheck();
      });
    },
  });
}
