import { buildMuteList } from '@1nky/protocol';
import { POW_BITS } from './config.js';
import { getPref, setPref } from './db.js';
import type { Tag } from './identity.js';
import { publishTemplate, type PublishOptions } from './publish.js';

/**
 * "Ignore this writer" — the local list, and the copy of it that goes up.
 *
 * Two halves, deliberately:
 *
 *   - The **device** list in `prefs` is the source of truth for what this
 *     writer sees. It is written first and it is written even when the wall is
 *     unreachable, so ignoring somebody works on the subway.
 *   - The **published** list (kind 10000) is a whole-list replacement, never a
 *     delta, so every change re-publishes the entire set. That is what makes
 *     the list portable to a second device.
 *
 * A synchronous mirror (`cache`) exists because the wall filters rows as they
 * are shaped, and shaping is not async. {@link loadIgnored} primes it once at
 * launch; everything after that reads the mirror.
 */

const IGNORED_KEY = 'ignored-writers';
const HEX64 = /^[0-9a-f]{64}$/;

let cache: string[] = [];
let primed = false;
const listeners = new Set<(list: readonly string[]) => void>();

function clean(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const lower = value.toLowerCase();
    if (HEX64.test(lower) && !out.includes(lower)) out.push(lower);
  }
  return out;
}

function announce(): void {
  const snapshot = ignoredWriters();
  for (const listener of listeners) listener(snapshot);
}

/**
 * Read the device list into the synchronous mirror. Safe to call repeatedly;
 * it always re-reads, so a route can use it as a plain loader.
 */
export async function loadIgnored(): Promise<string[]> {
  cache = clean(await getPref<unknown[]>(IGNORED_KEY, []));
  primed = true;
  return [...cache];
}

/** The list as it stands right now, without touching storage. */
export function ignoredWriters(): string[] {
  return [...cache];
}

/** True once {@link loadIgnored} has run at least once this session. */
export function ignoredReady(): boolean {
  return primed;
}

/** Is this writer on the list? The wall's hot path — must stay synchronous. */
export function isIgnored(pubkey: string): boolean {
  return cache.includes(pubkey.toLowerCase());
}

/** Watch the list so an open screen redraws when it changes. */
export function subscribeIgnored(listener: (list: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the mirror so a fresh fake store can be primed. */
export function resetIgnoredCache(): void {
  cache = [];
  primed = false;
  listeners.clear();
}

/** Put the whole list up as one replaceable event. Cheap tier — it is a signal. */
async function publishList(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  list: readonly string[],
  options: PublishOptions,
): Promise<void> {
  await publishTemplate(tag.secret, tag.pubkey, buildMuteList(list), POW_BITS.reaction, options);
}

async function persist(list: string[]): Promise<void> {
  cache = list;
  primed = true;
  await setPref(IGNORED_KEY, list);
  announce();
}

/**
 * Stop seeing a writer.
 *
 * Saves locally first, then publishes the whole list. A failure to publish
 * still leaves them ignored on this device — the local list is the one the UI
 * obeys — and the error is handed back so the screen can say the sync did not
 * land.
 */
export async function ignoreWriter(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  pubkey: string,
  options: PublishOptions = {},
): Promise<string[]> {
  const target = pubkey.toLowerCase();
  if (!HEX64.test(target)) throw new Error('No such writer.');
  // Ignoring yourself would empty your own wall. Quietly refuse.
  if (target === tag.pubkey.toLowerCase()) return ignoredWriters();

  const current = primed ? ignoredWriters() : await loadIgnored();
  if (current.includes(target)) return current;

  const next = [...current, target];
  await persist(next);
  await publishList(tag, next, options);
  return [...next];
}

/** Put a writer back on your wall. Same whole-list republish. */
export async function stopIgnoring(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  pubkey: string,
  options: PublishOptions = {},
): Promise<string[]> {
  const target = pubkey.toLowerCase();
  const current = primed ? ignoredWriters() : await loadIgnored();
  if (!current.includes(target)) return current;

  const next = current.filter((p) => p !== target);
  await persist(next);
  await publishList(tag, next, options);
  return [...next];
}
