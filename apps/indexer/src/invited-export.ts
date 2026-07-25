/**
 * `invite_edges` -> the JSON file strfry's write policy hot-reloads.
 *
 * The mirror image of `banlist-export.ts`, one rung down the same chain: a
 * writer redeems an invite, the store records the edge, and this module hands
 * the relay a file it can act on. `infra/strfry/write-policy.mjs` stats the path
 * at most once a second and reloads on any mtime/size change, so being put on
 * takes effect at the relay door within ~1s with no restart.
 *
 * WHAT THE RELAY DOES WITH IT. Nothing punitive — the opposite. A pubkey on this
 * list never pays `POW_BITS_NEW`: somebody already here vouched for them, which
 * is a better signal than any amount of grinding. It is a list of people who get
 * in easier, which is why the file carries no reasons and no inviters.
 *
 * THE ENTRY SHAPE IS BARE HEX STRINGS: `["<hex>", "<hex>", ...]`. That is the
 * second of the two shapes the policy's loader accepts (the ban list uses the
 * object form to carry a reason), and the policy lowercases and validates every
 * entry itself. We do the same on the way out, because a silent drop at the
 * relay is worse than never writing the entry.
 *
 * NO LOGGING (CLAUDE.md hard rule #1). Every row here is a pubkey and not one of
 * them ever reaches stderr. `exportInvitedListSafe` logs that an export failed
 * plus the filesystem error's own message, which can name a path and nothing
 * else.
 */

import { writeFileAtomic } from './atomic.js';
import * as log from './log.js';
import * as q from './queries.js';
import type { Queryable } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** The shape `selectInvitedList` hands back. */
export interface InvitedListSource {
  pubkey: string;
}

/**
 * Rows -> entries. Lowercased, deduplicated, and filtered to well-formed
 * 32-byte hex. Order is preserved from the query, which orders by pubkey, so the
 * file is byte-stable and a no-op export does not churn the policy's mtime check.
 */
export function invitedListEntries(rows: readonly InvitedListSource[]): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const pubkey = typeof row.pubkey === 'string' ? row.pubkey.trim().toLowerCase() : '';
    if (!HEX64.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    entries.push(pubkey);
  }
  return entries;
}

/** The exact bytes written. The trailing newline is for `cat`, not for JSON. */
function serialize(entries: readonly string[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** The exact bytes `exportInvitedList` would write for these rows. */
export function invitedListJson(rows: readonly InvitedListSource[]): string {
  return serialize(invitedListEntries(rows));
}

/**
 * Writes the invited list to `path`, atomically.
 *
 * Returns the number of entries written, or null when the export is disabled
 * (`INVITED_LIST_EXPORT_PATH` unset) — in which case not a single query is
 * issued and no file is touched. Throws on a filesystem failure; callers on the
 * ingestion path use `exportInvitedListSafe` instead.
 */
export async function exportInvitedList(
  db: Queryable,
  path: string | undefined,
): Promise<number | null> {
  if (path === undefined || path.trim() === '') return null;

  const sql = q.selectInvitedList();
  const { rows } = await db.query<InvitedListSource>(sql.text, sql.params);
  const entries = invitedListEntries(rows);

  await writeFileAtomic(path, serialize(entries));
  return entries.length;
}

/**
 * `exportInvitedList`, but an export failure never propagates.
 *
 * Used everywhere on the ingestion path: a full disk or a missing bind mount
 * must not stop the indexer from indexing. The consequence of a failed export is
 * only that a newly invited writer keeps paying the newcomer PoW tier until the
 * next successful one, which is a papercut, not an outage.
 */
export async function exportInvitedListSafe(
  db: Queryable,
  path: string | undefined,
): Promise<void> {
  try {
    await exportInvitedList(db, path);
  } catch (err) {
    log.error('invited list export failed', err);
  }
}
