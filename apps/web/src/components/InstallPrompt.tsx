import { COPY } from '@1nky/protocol';
import { useState } from 'react';
import { isIosSafari, isStandalone } from '../lib/platform.js';

const DISMISS_KEY = '1nky:install-dismissed';

/**
 * Add-to-Home-Screen card for iOS.
 *
 * Not a nicety. Safari evicts stored data after seven days without a visit,
 * and a home-screen web app is exempt from that clock — so on iOS, installing
 * is the difference between keeping a tag and losing it. iOS gives us no
 * install API, so we have to explain the two taps by hand.
 */
export function InstallPrompt(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1',
  );

  if (dismissed || !isIosSafari() || isStandalone()) return null;

  const hide = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* nothing to do */
    }
    setDismissed(true);
  };

  return (
    <div className="banner" role="note">
      <div className="banner__text">
        <strong>{COPY.blackbook.installPrompt}</strong>
        <br />
        <span className="muted">
          Tap Share, then <em>Add to Home Screen</em>. Takes five seconds.
        </span>
      </div>
      <button type="button" className="banner__x" onClick={hide} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
