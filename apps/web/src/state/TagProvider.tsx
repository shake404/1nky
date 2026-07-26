import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fingerprint } from '@1nky/protocol';
import {
  getCrewKey,
  hasCrewKey,
  listCrewKeys,
  type StoredCrewKey,
} from '../lib/crew-keys.js';
import { ensureCrewBackups, syncCrewKeys } from '../lib/crew-sync.js';
import { getPref, requestPersistence, setPref } from '../lib/db.js';
import {
  adoptTag,
  createTag as createTagRecord,
  forgetTag,
  loadTag,
  markBackedUp,
  renameTag,
  type Tag,
} from '../lib/identity.js';
import { loadIgnored } from '../lib/mute.js';
import { stopMiner } from '../lib/pow.js';
import { publishProfile } from '../lib/publish.js';
import { relay } from '../lib/relay.js';

/**
 * The prefs key that remembers WHICH identity the switcher last pointed at —
 * either the string `'me'` or a crew pubkey. Only the SELECTION is persisted;
 * the crew SECRET is always re-read fresh from the `crewkeys` ring on load and
 * is never copied anywhere near the single-slot `tag` store.
 */
const ACTING_AS_KEY = 'acting-as';

/**
 * Turn a crew keyring row into a posting-signer that satisfies the `Tag` shape
 * `publish.ts` already accepts (`Pick<Tag,'secret'|'pubkey'|'name'>` plus the
 * fields the flick/thread tier logic reads). A crew in the ring was FOUNDED on
 * this device, which already published its kind-0 + definition, so it is past
 * the newcomer tier — `hasPosted: true`. This object lives only in memory; it
 * is never written back to any durable store.
 */
function crewSigner(row: StoredCrewKey): Tag {
  return {
    secret: new Uint8Array(row.secret),
    pubkey: row.pubkey,
    name: row.name,
    mark: fingerprint(row.pubkey),
    createdAt: 0,
    backedUp: true,
    hasPosted: true,
  };
}

interface TagContextValue {
  tag: Tag | null;
  /**
   * The writer's OWN tag — the single-slot persisted identity. An explicit
   * alias of `tag` so posting surfaces can name the me-vs-active distinction
   * without ambiguity. Settings, blackbook, hang-it-up, restore/backup and the
   * /me wall all read THIS, never `active`.
   */
  me: Tag | null;
  /**
   * The identity currently SIGNING posts. Defaults to `me`; points at a crew
   * key from the ring while "posting as a crew" is switched on. Non-persistent
   * overlay — a reload starts back on `me` unless the remembered selection is
   * re-hydrated from the ring. Only the posting surfaces (flicks, threads,
   * comments, DMs, media-upload auth) use this.
   */
  active: Tag | null;
  /** The crew pubkey when acting as a crew, else null. */
  actingAsCrew: string | null;
  /**
   * Switch the active signer. `null` returns to `me`. Loads the crew secret
   * fresh from the ring; if the ring lacks it, this is a no-op and returns
   * false (never leaves `active` pointing at a secret it cannot load).
   */
  actAs: (pubkey: string | null) => Promise<boolean>;
  /** The crews held in the ring, for the switcher menu. */
  heldCrews: () => Promise<StoredCrewKey[]>;
  /**
   * Re-check that the active crew key still exists in the ring. If it vanished
   * mid-session, fall back to `me` and return false (the caller toasts). Safe
   * no-op returning true when already on `me`.
   */
  verifyActive: () => Promise<boolean>;
  /** False only during the first read of local storage. */
  ready: boolean;
  /** True when the browser promised not to evict us. */
  persisted: boolean;
  /**
   * Make a tag. `putOn` is passed straight through to the writer's first
   * profile — the only event that can carry it (see `lib/invites.ts`).
   */
  createTag: (name: string, putOn?: { inviteId: string; inviterPubkey: string }) => Promise<Tag>;
  restoreTag: (secret: Uint8Array, name: string) => Promise<Tag>;
  setBackedUp: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  hangItUp: () => Promise<void>;
  refresh: () => Promise<void>;
}

const TagContext = createContext<TagContextValue | null>(null);

export function TagProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tag, setTag] = useState<Tag | null>(null);
  const [ready, setReady] = useState(false);
  const [persisted, setPersisted] = useState(false);
  // Which tag pubkey we have already pulled crew keys for, so the sync runs
  // once per tag load rather than on every render.
  const syncedFor = useRef<string | null>(null);
  /**
   * The crew key the switcher currently points at, held ONLY in memory. `null`
   * means "posting as your own tag". This never touches the `tag` store.
   */
  const [activeCrew, setActiveCrew] = useState<StoredCrewKey | null>(null);

  const refresh = useCallback(async () => {
    setTag(await loadTag());
  }, []);

  // On login / a tag becoming available, pull the writer's own crew-key
  // backups off the relay into this device's keyring, so a founder on a fresh
  // device gets their crews (and founder panel) back. Reads the tag only —
  // never writes the single-identity store — and is a silent, idempotent
  // best-effort background sync (no user-facing copy).
  useEffect(() => {
    if (!tag) return;
    if (syncedFor.current === tag.pubkey) return;
    syncedFor.current = tag.pubkey;
    // Seed backups for crews this device already holds (so pre-sync crews reach
    // the writer's other devices), then pull anything held elsewhere down.
    void ensureCrewBackups(tag)
      .catch(() => undefined)
      .finally(() => void syncCrewKeys(tag).catch(() => undefined));
  }, [tag]);

  useEffect(() => {
    let live = true;
    void (async () => {
      // Every launch, not just the first: Safari's 7-day eviction clock is
      // the fastest way for a writer to lose their tag.
      const granted = await requestPersistence();
      const existing = await loadTag();
      // Prime the ignored-writers mirror before the first wall renders, so a
      // writer never gets a flash of somebody they told us to hide.
      await loadIgnored().catch(() => []);
      // Re-hydrate the LAST switcher selection — but only the pubkey; the crew
      // secret is read fresh from the ring here, never from the `tag` store.
      // If there is no me-tag, or the remembered crew is gone from the ring,
      // we stay on the writer's own tag.
      let restoredCrew: StoredCrewKey | null = null;
      if (existing) {
        const remembered = await getPref<string>(ACTING_AS_KEY, 'me');
        if (remembered && remembered !== 'me') {
          restoredCrew = (await getCrewKey(remembered).catch(() => undefined)) ?? null;
        }
      }
      if (!live) return;
      setPersisted(granted);
      setTag(existing);
      setActiveCrew(restoredCrew);
      setReady(true);
      if (existing) relay.connect();
    })();
    return () => {
      live = false;
    };
  }, []);

  const actAs = useCallback(async (pubkey: string | null): Promise<boolean> => {
    if (pubkey === null) {
      setActiveCrew(null);
      await setPref(ACTING_AS_KEY, 'me');
      return true;
    }
    // Load the secret FRESH from the ring. A miss is a no-op: `active` stays
    // exactly where it was, never pointing at a secret we cannot load.
    const row = await getCrewKey(pubkey);
    if (!row) return false;
    setActiveCrew(row);
    await setPref(ACTING_AS_KEY, pubkey);
    return true;
  }, []);

  const heldCrews = useCallback(() => listCrewKeys(), []);

  const verifyActive = useCallback(async (): Promise<boolean> => {
    if (!activeCrew) return true;
    if (await hasCrewKey(activeCrew.pubkey)) return true;
    // The crew key was removed from the ring mid-session — fall back to me.
    setActiveCrew(null);
    await setPref(ACTING_AS_KEY, 'me');
    return false;
  }, [activeCrew]);

  const createTag = useCallback(
    async (name: string, putOn?: { inviteId: string; inviterPubkey: string }): Promise<Tag> => {
      const created = await createTagRecord(name);
      setTag(created);
      relay.connect();
      // The profile is the writer's first event, so it pays the newcomer's
      // work. Fire and forget — a wall that is briefly unreachable must not
      // block someone from getting in. A put-on rides on this one event and
      // no other: it is the record of who vouched for them turning up.
      void publishProfile(created, { first: true, ...(putOn ? { putOn } : {}) }).catch(() => undefined);
      return created;
    },
    [],
  );

  const restoreTag = useCallback(async (secret: Uint8Array, name: string): Promise<Tag> => {
    const restored = await adoptTag(secret, name);
    setTag(restored);
    relay.connect();
    return restored;
  }, []);

  const setBackedUp = useCallback(async () => {
    setTag(await markBackedUp());
  }, []);

  const rename = useCallback(async (name: string) => {
    const updated = await renameTag(name);
    setTag(updated);
    if (updated) void publishProfile(updated, { first: false }).catch(() => undefined);
  }, []);

  const hangItUp = useCallback(async () => {
    stopMiner();
    await forgetTag();
    // "Hang it up" operates on ME only, but it also drops any crew overlay so
    // we never leave `active` pointing at a signer with no owner behind it.
    setActiveCrew(null);
    await setPref(ACTING_AS_KEY, 'me');
    setTag(null);
  }, []);

  // The active signer: the crew overlay when one is switched on, otherwise the
  // writer's own tag. Never falls back to a crew when there is no me-tag.
  const active = useMemo<Tag | null>(
    () => (tag && activeCrew ? crewSigner(activeCrew) : tag),
    [tag, activeCrew],
  );
  const actingAsCrew = tag && activeCrew ? activeCrew.pubkey : null;

  const value = useMemo<TagContextValue>(
    () => ({
      tag,
      me: tag,
      active,
      actingAsCrew,
      actAs,
      heldCrews,
      verifyActive,
      ready,
      persisted,
      createTag,
      restoreTag,
      setBackedUp,
      rename,
      hangItUp,
      refresh,
    }),
    [
      tag,
      active,
      actingAsCrew,
      actAs,
      heldCrews,
      verifyActive,
      ready,
      persisted,
      createTag,
      restoreTag,
      setBackedUp,
      rename,
      hangItUp,
      refresh,
    ],
  );

  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
}

export function useTag(): TagContextValue {
  const context = useContext(TagContext);
  if (!context) throw new Error('useTag must be used inside <TagProvider>');
  return context;
}

/** Convenience for routes that cannot render without a tag. */
export function useRequiredTag(): Tag | null {
  return useTag().tag;
}

/**
 * The active-signer surface, for POSTING surfaces only (flicks, threads,
 * comments, DMs, media-upload auth). Everything that means "the writer's own
 * identity" — settings, blackbook, hang-it-up, restore/backup, the /me wall —
 * must keep using {@link useTag}'s `tag`/`me`, NOT `active`.
 */
export interface ActiveTagValue {
  me: Tag | null;
  active: Tag | null;
  actingAsCrew: string | null;
  actAs: (pubkey: string | null) => Promise<boolean>;
  heldCrews: () => Promise<StoredCrewKey[]>;
  verifyActive: () => Promise<boolean>;
}

export function useActiveTag(): ActiveTagValue {
  const { me, active, actingAsCrew, actAs, heldCrews, verifyActive } = useTag();
  return { me, active, actingAsCrew, actAs, heldCrews, verifyActive };
}
