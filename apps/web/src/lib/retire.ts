import { KINDS, type SignedEvent } from '@1nky/protocol';
import { getPref, setPref } from './db.js';
import { ownPostIds, type Tag } from './identity.js';
import { buffEvents, publishProfile, type Stage } from './publish.js';
import { relay } from './relay.js';

/**
 * Retiring a name — the machinery behind "Hang it up".
 *
 * A retirement is three acts, in this order: everything the tag ever put up
 * comes down, the name is marked retired so anybody who looks it up sees that,
 * and only then does the device forget the secret. That order matters: the
 * secret is the only thing that can take the work down, so wiping first would
 * strand it up forever.
 *
 * Nothing here touches the crew keyring (`crew-keys.ts`). A writer hanging up a
 * personal name may still be holding crews other people depend on; those get
 * handed off or burned separately, and the screen says so.
 */

/** What a retirement pulls down. */
export const RETIRED_KINDS: readonly number[] = Object.freeze([
  KINDS.PROFILE,
  KINDS.NOTE,
  KINDS.FLICK,
  KINDS.VIDEO,
  KINDS.COMMENT,
]);

/** What the retired name's last profile says. */
export const RETIRED_BIO = 'hung it up.';

/**
 * Where the leftovers live between attempts.
 *
 * Kept in `prefs` (never in the `tag` row — that store is single-slot and is not
 * being restructured) so a rejected batch or a killed tab leaves behind exactly
 * what is still standing, and the screen can offer to finish the job.
 */
const REMAINING_KEY = 'hang-it-up-remaining';

/** How far back the wall is asked to look for the tag's own work. */
export const RETIRE_LOOKBACK = 500;

/**
 * How many ids ride on one takedown.
 *
 * One takedown per post would mean one lot of work per post, which on a phone
 * is minutes for a prolific writer. One takedown for four hundred ids is a
 * frame big enough for the wall to refuse. Twenty is small enough to retry
 * cheaply and big enough that a full history is a handful of rounds.
 */
export const RETIRE_BATCH = 20;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Everything this tag has ever put up, as best as anyone can know.
 *
 * Two sources, unioned: what THIS device remembers (instant, but blind to
 * anything posted from another phone) and what the wall holds under this tag
 * (complete, but only as far back as it was asked to look, and unavailable when
 * the wall cannot be reached). Neither alone is enough — the local list is why
 * an unreachable wall still retires something, and the remote list is why a
 * retirement taken on a second device is not a no-op.
 */
export async function collectOwnIds(pubkey: string): Promise<string[]> {
  const local = await ownPostIds().catch(() => [] as string[]);

  let remote: string[] = [];
  try {
    const events = await relay.query([
      { authors: [pubkey], kinds: [...RETIRED_KINDS], limit: RETIRE_LOOKBACK },
    ]);
    remote = events
      .filter((event) => event.pubkey === pubkey)
      .map((event) => event.id);
  } catch {
    remote = [];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...local, ...remote]) {
    if (typeof id !== 'string' || !HEX64.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

interface PendingRecord {
  /** Whose retirement this is. */
  pubkey: string;
  remaining: string[];
}

/**
 * A retirement THIS tag started and did not finish, or null when none did.
 *
 * The empty ARRAY and null mean different things and the difference is the
 * whole point: `[]` is "everything came down but the name was never marked", so
 * the job is still unfinished; `null` is "no retirement is underway".
 *
 * Whose job it was is stored alongside it, because a device that gave up
 * halfway and then brought a DIFFERENT tag back through restore must not be
 * offered somebody else's leftovers — those ids are not this tag's to take down.
 */
export async function pendingRetirement(pubkey: string): Promise<string[] | null> {
  const record = await getPref<PendingRecord | null>(REMAINING_KEY, null);
  if (!record || typeof record !== 'object' || !Array.isArray(record.remaining)) return null;
  if (record.pubkey !== pubkey) return null;
  return record.remaining;
}

export function setPendingRetirement(pubkey: string, ids: readonly string[]): Promise<void> {
  return setPref(REMAINING_KEY, { pubkey, remaining: [...ids] });
}

export function clearPendingRetirement(): Promise<void> {
  return setPref(REMAINING_KEY, null);
}

export interface RitualProgress {
  /** How many of the tag's posts have been taken down so far. */
  done: number;
  total: number;
}

export interface RitualOptions {
  onProgress?: (progress: RitualProgress) => void;
  onStage?: (stage: Stage) => void;
}

/**
 * Take it all down, in batches, remembering what is left after each one.
 *
 * The leftovers are written BEFORE the first batch and again after every
 * accepted one, so whatever kills this — a refusal, a closed tab, a phone that
 * went to sleep on a slow round of work — leaves the device holding precisely
 * the ids that are still up.
 */
export async function buffEverything(
  tag: Tag,
  ids: readonly string[],
  options: RitualOptions = {},
): Promise<void> {
  const total = ids.length;
  let remaining = [...ids];

  await setPendingRetirement(tag.pubkey, remaining);
  options.onProgress?.({ done: 0, total });

  while (remaining.length > 0) {
    const batch = remaining.slice(0, RETIRE_BATCH);
    await buffEvents(tag, batch, RETIRED_KINDS, {
      ...(options.onStage ? { onStage: options.onStage } : {}),
    });
    remaining = remaining.slice(batch.length);
    await setPendingRetirement(tag.pubkey, remaining);
    options.onProgress?.({ done: total - remaining.length, total });
  }
}

/**
 * The last thing the name ever says.
 *
 * A fresh profile under the same name, so a writer who looks the tag up after
 * the fact reads that it was retired rather than finding a blank.
 */
export function markRetired(tag: Tag, options: RitualOptions = {}): Promise<SignedEvent> {
  return publishProfile(tag, {
    first: false,
    bio: RETIRED_BIO,
    ...(options.onStage ? { onStage: options.onStage } : {}),
  });
}
