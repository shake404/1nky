import { fingerprint } from '@1nky/protocol';
import { fetchProfile } from './profiles.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Pull a writer's or crew's id out of a pasted link or bare id.
 *
 * Accepts:
 *   - a writer link (`https://1nky.com/w/<hex>`, `/w/<hex>`)
 *   - a crew link (`https://1nky.com/crew/<hex>`, `/crew/<hex>`)
 *   - the raw 64-hex id directly
 *
 * A mark is a one-way fingerprint and CANNOT be reversed to an id, so asking
 * for one would be a footgun — this deliberately only accepts forms that
 * already carry the id. Anything else (a name, a mark, junk) returns `null`.
 *
 * The one parser behind three call sites: the crew founder panel's "put
 * someone on" lookup (`resolveWriterInput` in `crews.ts`, kept as a thin
 * re-export for its existing callers), the account-restore locked-copy
 * handle, and Word's "start one" lookup below.
 */
export function resolveLookupInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pull `/w/<hex>` or `/crew/<hex>` out of a full URL OR a bare path. A
  // leading search/hash is tolerated so a pasted browser address bar works
  // either way.
  const pathMatch = /(?:^|\/)(?:w|crew)\/([0-9a-fA-F]{64})(?:[/#?]|$)/.exec(trimmed);
  if (pathMatch) return pathMatch[1]!.toLowerCase();

  const cleaned = trimmed.replace(/^#+/, '').trim();
  if (HEX64.test(cleaned)) return cleaned.toLowerCase();
  return null;
}

export interface LookupHit {
  status: 'found';
  pubkey: string;
  name: string | null;
  mark: string;
  avatarSha256: string | null;
}

export type LookupOutcome = { status: 'invalid' } | { status: 'not-found' } | LookupHit;

/**
 * Resolve a pasted link/id all the way to a row worth showing, or the reason
 * there is not one.
 *
 * - `invalid` — could not make out an id at all (garbage, a name, a mark).
 * - `not-found` — the id parses fine, but nothing has ever posted a profile
 *   there. Treated as "no such writer or crew" rather than silently letting
 *   someone start a conversation with a dead address.
 * - `found` — a row: `name` is `null` when unset (render "unnamed" at the
 *   call site, matching every other writer row in the app).
 */
export async function lookupTarget(input: string): Promise<LookupOutcome> {
  const pubkey = resolveLookupInput(input);
  if (!pubkey) return { status: 'invalid' };
  const meta = await fetchProfile(pubkey).catch(() => null);
  if (!meta) return { status: 'not-found' };
  return {
    status: 'found',
    pubkey,
    name: meta.name?.trim() || null,
    mark: fingerprint(pubkey),
    avatarSha256: meta.avatarSha256 ?? null,
  };
}
