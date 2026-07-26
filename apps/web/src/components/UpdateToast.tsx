import { COPY } from '@1nky/protocol';
import { useEffect, useState } from 'react';
import { onUpdateAvailable, type ApplyUpdate } from '../lib/updateBus.js';

/**
 * "New version, tap to refresh" — the fix for a phone stuck on a stale
 * build showing bugs that were already fixed. Silent until `updateBus`
 * hears from the service-worker registration (see registerAppUpdates.ts)
 * that a build is installed and waiting; tapping it activates that build
 * and reloads.
 */
export function UpdateToast(): JSX.Element | null {
  const [apply, setApply] = useState<ApplyUpdate | null>(null);

  useEffect(() => onUpdateAvailable((fn) => setApply(() => fn)), []);

  if (!apply) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <button type="button" className="btn btn--go btn--block update-toast__btn" onClick={apply}>
        {COPY.freshCoat.label}
      </button>
    </div>
  );
}
