import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredCrewKey } from '../lib/crew-keys.js';
import { useActiveTag } from '../state/TagProvider.js';
import { useToast } from '../state/ToastProvider.js';

/**
 * The "posting as" chip in the top bar, and the little menu hung off it.
 *
 * This is the ONLY door to the active-signer overlay. The writer's own tag is
 * always the persisted identity (single-slot `tag` store); switching here just
 * points the SIGNER at a crew key held in the separate ring for the length of
 * the session. Nothing here writes the `tag` store.
 *
 * Copy stays graffiti-native: "speaking as your tag" / "posting as <crew>" —
 * never identity / key / account.
 */
export function CrewSwitcher(): JSX.Element | null {
  const { me, actingAsCrew, actAs, heldCrews, verifyActive } = useActiveTag();
  const { say } = useToast();

  const [crews, setCrews] = useState<StoredCrewKey[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const loadCrews = useCallback(async () => {
    setCrews(await heldCrews().catch(() => []));
  }, [heldCrews]);

  // First paint: pull the ring so the menu is ready, and make sure the active
  // crew is still there — if it vanished, fall back to the writer's own tag.
  useEffect(() => {
    void (async () => {
      await loadCrews();
      const stillGood = await verifyActive();
      if (!stillGood) say('Back to your tag.');
    })();
  }, [loadCrews, verifyActive, say]);

  // Close the menu on an outside click, so a stray tap never leaves it hanging.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!me) return null;

  const active = crews.find((c) => c.pubkey === actingAsCrew);
  const activeName = active?.name ?? me.name;

  const openMenu = async (): Promise<void> => {
    await loadCrews();
    // Opening the menu is also a chance to notice a crew key that was removed
    // from the ring while it was the active signer — fall back before showing.
    const stillGood = await verifyActive();
    if (!stillGood) say('Back to your tag.');
    setOpen((v) => !v);
  };

  const pick = async (pubkey: string | null): Promise<void> => {
    setOpen(false);
    if (pubkey === null) {
      await actAs(null);
      return;
    }
    const ok = await actAs(pubkey);
    if (!ok) {
      // The key was pulled between listing and picking — refresh and stay put.
      await loadCrews();
      say('That crew is gone from this device.');
    }
  };

  const posting = actingAsCrew !== null;

  return (
    <div className="switcher" ref={box}>
      <button
        type="button"
        className={`speaking-as ${posting ? 'speaking-as--crew' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={posting ? 'Posting as a crew — tap to switch back' : 'Post as one of your crews'}
        onClick={() => void openMenu()}
      >
        {posting ? `posting as ${activeName}` : `speaking as ${me.name}`}
      </button>

      {posting ? (
        <button
          type="button"
          className="switcher__back"
          title="Back to your tag"
          onClick={() => void pick(null)}
        >
          back to you
        </button>
      ) : null}

      {open ? (
        <div className="switcher__menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!posting}
            className={`switcher__item ${!posting ? 'is-active' : ''}`}
            onClick={() => void pick(null)}
          >
            You ({me.name})
          </button>
          {crews.length === 0 ? (
            <p className="switcher__empty">No crews on this device yet.</p>
          ) : (
            crews.map((crew) => (
              <button
                key={crew.pubkey}
                type="button"
                role="menuitemradio"
                aria-checked={crew.pubkey === actingAsCrew}
                className={`switcher__item ${crew.pubkey === actingAsCrew ? 'is-active' : ''}`}
                onClick={() => void pick(crew.pubkey)}
              >
                {(crew.name || 'crew').toUpperCase()}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
