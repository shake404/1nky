/**
 * `banned_pubkeys` -> the JSON file strfry's write policy hot-reloads.
 *
 * This is the last link in the moderation chain: a moderator signs a kind-30078
 * ban, the store applies it to Postgres, and this module hands the relay a file
 * it can act on. `infra/strfry/write-policy.mjs` stats that path at most once a
 * second and reloads on any mtime/size change, so a ban takes effect at the
 * relay door within ~1s with no restart and no reconnect.
 *
 * TWO THINGS MATTER HERE.
 *
 * 1. ATOMICITY. The write policy re-reads the file the instant the mtime moves.
 *    A partial write would be unparseable JSON, and while the policy is careful
 *    enough to keep its last good list rather than fail open, relying on that is
 *    not a design. So the bytes go to `<path>.tmp` in the SAME directory and are
 *    then renamed over the target — one atomic replace, never a half file.
 *
 * 2. NO LOGGING (CLAUDE.md hard rule #1). The rows here are pubkeys. Not one of
 *    them is ever written to stderr. `exportBanListSafe` logs the fact that an
 *    export failed plus the filesystem error's own message, which can name a
 *    path but cannot contain event data.
 */

import { rename, writeFile } from 'node:fs/promises';

import * as log from './log.js';
import * as q from './queries.js';
import type { Queryable } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** One entry of the exported file. The write policy also accepts bare strings. */
export interface BanListEntry {
  pubkey: string;
  reason: string | null;
}

/** The shape `selectBanList` hands back. */
export interface BanListSource {
  pubkey: string;
  reason: string | null;
}

/**
 * Rows -> entries. Lowercased, deduplicated, and filtered to well-formed
 * 32-byte hex, because the write policy silently drops anything else and a
 * silent drop is worse than never writing it.
 */
export function banListEntries(rows: readonly BanListSource[]): BanListEntry[] {
  const entries: BanListEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const pubkey = typeof row.pubkey === 'string' ? row.pubkey.trim().toLowerCase() : '';
    if (!HEX64.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    entries.push({ pubkey, reason: row.reason ?? null });
  }
  return entries;
}

/**
 * The exact bytes written. A trailing newline keeps the file well-mannered for
 * `cat` and for editors; `JSON.parse` does not care.
 */
function serialize(entries: readonly BanListEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** The exact bytes `exportBanList` would write for these rows. */
export function banListJson(rows: readonly BanListSource[]): string {
  return serialize(banListEntries(rows));
}

/**
 * Writes the ban list to `path`, atomically.
 *
 * Returns the number of entries written, or null when the export is disabled
 * (`BAN_LIST_EXPORT_PATH` unset) — in which case not a single query is issued
 * and no file is touched. Throws on a filesystem failure; callers on the
 * ingestion path use `exportBanListSafe` instead.
 */
export async function exportBanList(db: Queryable, path: string | undefined): Promise<number | null> {
  if (path === undefined || path.trim() === '') return null;

  const sql = q.selectBanList();
  const { rows } = await db.query<BanListSource>(sql.text, sql.params);
  const entries = banListEntries(rows);

  // Same directory as the target, so the rename is a rename and not a
  // cross-device copy (which would not be atomic).
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serialize(entries), 'utf8');
  await rename(tmp, path);
  return entries.length;
}

/**
 * `exportBanList`, but an export failure never propagates.
 *
 * Used everywhere on the ingestion path: a full disk or a missing bind mount
 * must not stop the indexer from indexing. The log line names the operation and
 * the filesystem error, and nothing else — no pubkeys, no counts of who.
 */
export async function exportBanListSafe(db: Queryable, path: string | undefined): Promise<void> {
  try {
    await exportBanList(db, path);
  } catch (err) {
    log.error('banlist export failed', err);
  }
}
