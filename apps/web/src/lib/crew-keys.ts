import { db, type StoredCrewKey } from './db.js';

/**
 * The crew keyring — the crew secret keys of crews the writer FOUNDED.
 *
 * This is a SEPARATE store from the single-slot identity (`tag`). Founders
 * sign crew-management events (roster edits, crew kind-0 updates) with the
 * crew's *own* key straight out of this ring, WITHOUT swapping their main
 * posting tag. The main identity store and every existing login / post / DM
 * flow are untouched: nothing here ever feeds `publishProfile(tag, ...)` or
 * the restore/swap path.
 *
 * The crew secret is still hand-exported as a blackbook at mint time (see
 * CreateCrew) — the keyring is a convenience for the FOUNDER on THIS device,
 * not a replacement for handing the crew blackbook to members.
 */

export type { StoredCrewKey };

/** Normalise the secret to a plain Uint8Array (structured clone can hand back an ArrayBuffer view). */
function normalise(row: StoredCrewKey): StoredCrewKey {
  return { pubkey: row.pubkey, secret: new Uint8Array(row.secret), name: row.name };
}

export async function saveCrewKey(crew: { pubkey: string; secret: Uint8Array; name: string }): Promise<void> {
  await (await db()).put('crewkeys', {
    pubkey: crew.pubkey,
    secret: new Uint8Array(crew.secret),
    name: crew.name,
  });
}

export async function getCrewKey(pubkey: string): Promise<StoredCrewKey | undefined> {
  const row = await (await db()).get('crewkeys', pubkey);
  return row ? normalise(row) : undefined;
}

export async function listCrewKeys(): Promise<StoredCrewKey[]> {
  const rows = await (await db()).getAll('crewkeys');
  return rows.map(normalise);
}

export async function hasCrewKey(pubkey: string): Promise<boolean> {
  const row = await (await db()).get('crewkeys', pubkey);
  return row !== undefined;
}

export async function removeCrewKey(pubkey: string): Promise<void> {
  await (await db()).delete('crewkeys', pubkey);
}