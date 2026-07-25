import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * The only durable state on the device.
 *
 * IndexedDB rather than localStorage for two reasons the handoff calls out:
 * it stores binary (`Uint8Array`) without a base64 round-trip, and it is the
 * store `navigator.storage.persist()` actually protects.
 */
export interface StoredTag {
  /** Always `"me"` — this client holds one tag at a time. */
  id: 'me';
  /** 32 raw bytes. Never encoded, never logged, never leaves the device. */
  secret: Uint8Array;
  /** Hex pubkey, cached so we do not re-derive it on every render. */
  pubkey: string;
  /** The writer's chosen tag name. Not unique — always shown with the mark. */
  name: string;
  createdAt: number;
  /** True once the writer has exported a blackbook. Drives the nag. */
  backedUp: boolean;
  /** True once they have put anything up. The nag waits for the first post. */
  hasPosted: boolean;
}

/**
 * A crew secret key this device owns because it FOUNDED the crew.
 *
 * Kept in a SEPARATE store from the single-slot `tag` on purpose: the founder
 * signs crew-management events with the crew key WITHOUT swapping their main
 * posting identity. The main identity store (`tag`) and every login / post /
 * DM flow stay exactly as they are — this keyring is only ever read by the
 * founder-only crew management panel. One row per founded crew, keyed by the
 * crew's pubkey.
 */
export interface StoredCrewKey {
  /** The crew's own hex pubkey. Primary key. */
  pubkey: string;
  /** 32 raw bytes — the crew's secret. Never logged, never leaves the device. */
  secret: Uint8Array;
  /** The crew's tag name, for the directory listing only. */
  name: string;
}

export interface OneInkyDB extends DBSchema {
  tag: { key: string; value: StoredTag };
  /** Small odds and ends: buffed ids, seen prompts, own post ids. */
  prefs: { key: string; value: unknown };
  /** Crew secret keys for crews this device founded (crew keyring). */
  crewkeys: { key: string; value: StoredCrewKey };
}

const DB_NAME = '1nky';
const DB_VERSION = 2;

let handle: Promise<IDBPDatabase<OneInkyDB>> | null = null;

export function db(): Promise<IDBPDatabase<OneInkyDB>> {
  handle ??= openDB<OneInkyDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('tag')) {
        database.createObjectStore('tag', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('prefs')) {
        database.createObjectStore('prefs');
      }
      if (!database.objectStoreNames.contains('crewkeys')) {
        database.createObjectStore('crewkeys', { keyPath: 'pubkey' });
      }
    },
  });
  return handle;
}

/** Test seam: drops the cached connection so a fresh fake store can be used. */
export function resetDbHandle(): void {
  handle = null;
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const value = await (await db()).get('prefs', key);
  return value === undefined ? fallback : (value as T);
}

export async function setPref(key: string, value: unknown): Promise<void> {
  await (await db()).put('prefs', value, key);
}

/**
 * Ask the browser to exempt our storage from eviction.
 *
 * Called on every launch, not just the first: Safari's 7-day cap is the
 * single biggest way a writer loses their tag, and the grant is not sticky
 * across all engines.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
