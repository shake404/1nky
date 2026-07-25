import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ensureCrewBackups, syncCrewKeys } from '../lib/crew-sync.js';
import { requestPersistence } from '../lib/db.js';
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

interface TagContextValue {
  tag: Tag | null;
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
      if (!live) return;
      setPersisted(granted);
      setTag(existing);
      setReady(true);
      if (existing) relay.connect();
    })();
    return () => {
      live = false;
    };
  }, []);

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
    setTag(null);
  }, []);

  const value = useMemo<TagContextValue>(
    () => ({ tag, ready, persisted, createTag, restoreTag, setBackedUp, rename, hangItUp, refresh }),
    [tag, ready, persisted, createTag, restoreTag, setBackedUp, rename, hangItUp, refresh],
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
