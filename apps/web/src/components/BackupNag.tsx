import { COPY } from '@1nky/protocol';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTag } from '../state/TagProvider.js';

const DISMISS_KEY = '1nky:nag-dismissed';

/**
 * The backup nag.
 *
 * Appears only after the writer has actually put something up (nagging
 * someone who has not posted yet is just noise), stays until they export,
 * and can be pushed away for the session but never permanently — losing a
 * blackbook is unrecoverable and the handoff calls this mandatory.
 */
export function BackupNag(): JSX.Element | null {
  const { tag } = useTag();
  const [dismissed, setDismissed] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1',
  );

  if (!tag || tag.backedUp || !tag.hasPosted || dismissed) return null;

  const hide = (): void => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode; the nag simply comes back */
    }
    setDismissed(true);
  };

  return (
    <div className="banner" role="alert">
      <div className="banner__text">
        <strong>{COPY.blackbook.nag}</strong>
        <br />
        <span className="muted">{COPY.blackbook.warning}</span>
      </div>
      <Link to="/backup" className="btn btn--go btn--sm sticker">
        {COPY.blackbook.action}
      </Link>
      <button type="button" className="banner__x" onClick={hide} aria-label="Not now">
        &times;
      </button>
    </div>
  );
}
