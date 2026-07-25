import { buildInvite, decodeInviteCode, encodeInviteCode, type EventTemplate } from '@1nky/protocol';
import { POW_BITS } from './config.js';
import { getPref, setPref } from './db.js';
import type { Tag } from './identity.js';
import { publishTemplate, type PublishOptions } from './publish.js';

/**
 * Getting put on — the two halves of it, on this side of the glass.
 *
 * **Handing one out** is a signed event only your tag could have produced. You
 * publish it, and out the other end comes one string to hand to one writer.
 * Nothing about the person you hand it to is recorded anywhere — the string is
 * the whole thing, and it is worth exactly one writer.
 *
 * **Taking one** happens on the newcomer's very first profile: the put-on rides
 * along on it, which is how the wall learns who vouched for them. That is why
 * this only ever runs during onboarding — there is no second first profile.
 *
 * The local list is a convenience for the person handing them out (so a code
 * can be re-shown after a reload), not a ledger: it holds the code and when it
 * was made, and never who it went to.
 */

/** One put-on this device handed out, kept so it can be shown again. */
export interface MintedPutOn {
  /** The shareable string. Hand it to one writer. */
  code: string;
  /** When it was made, in seconds. */
  createdAt: number;
}

/** What a code carries once it has been read back. */
export interface PutOn {
  inviteId: string;
  inviterPubkey: string;
}

const MINTED_KEY = 'put-ons';

/** Where a shared put-on link points. The receiver lands on the pick screen. */
const LINK_BASE = 'https://1nky.com/pick';

/** The one thing said about a code that does not read back. */
export const NOT_A_PUT_ON = "That's not a real put-on.";

/**
 * A fresh id: 16 random bytes as 32 hex characters.
 *
 * Straight out of the platform's own randomness — never a timestamp, never a
 * counter, never anything derived from the writer, so a code cannot be guessed
 * from another code or worked backwards to the tag that made it.
 */
export function newPutOnId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The unsigned event a put-on is. Pure — exposed so tests can read it. */
export function putOnTemplate(inviteId: string): EventTemplate {
  return buildInvite(inviteId);
}

/** The full link to hand over, for the writers who would rather tap than type. */
export function putOnLink(code: string): string {
  return `${LINK_BASE}?puton=${encodeURIComponent(code)}`;
}

/** Every put-on this device has handed out, newest first. */
export async function loadMintedPutOns(): Promise<MintedPutOn[]> {
  const rows = await getPref<MintedPutOn[]>(MINTED_KEY, []);
  return rows.filter(
    (row): row is MintedPutOn =>
      typeof row === 'object' && row !== null && typeof row.code === 'string' && Boolean(row.code),
  );
}

/** Remember one, so a reload does not lose a code that is already handed out. */
export async function rememberMintedPutOn(entry: MintedPutOn): Promise<void> {
  const current = await loadMintedPutOns();
  if (current.some((row) => row.code === entry.code)) return;
  // Newest first, and capped — this is a convenience list, not an archive.
  await setPref(MINTED_KEY, [entry, ...current].slice(0, 100));
}

/**
 * Hand one out: mint an id, publish the signed event, keep the code.
 *
 * Priced at the ordinary post tier — the writer doing this is already on the
 * wall, so there is nothing newcomer-shaped about it. The code is only saved
 * AFTER the wall took the event, so a failed publish never leaves a dead string
 * on screen that nobody could redeem.
 */
export async function mintPutOn(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  options: PublishOptions = {},
): Promise<MintedPutOn> {
  const inviteId = newPutOnId();
  const event = await publishTemplate(tag.secret, tag.pubkey, putOnTemplate(inviteId), POW_BITS.post, options);
  const entry: MintedPutOn = {
    code: encodeInviteCode(inviteId, tag.pubkey),
    createdAt: event.created_at,
  };
  await rememberMintedPutOn(entry).catch(() => undefined);
  return entry;
}

/**
 * Read a put-on back out of whatever the newcomer pasted.
 *
 * Accepts the bare code, the full share link, or anything with the code in the
 * query string — writers paste browser address bars. Returns null on junk, and
 * the caller says {@link NOT_A_PUT_ON}.
 */
export function readPutOnCode(raw: string): PutOn | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = decodeInviteCode(trimmed);
  if (direct) return direct;

  // A pasted link: pull the value out of `?puton=` without needing a base URL.
  const fromQuery = /[?&]puton=([^&#\s]+)/i.exec(trimmed);
  if (fromQuery?.[1]) {
    return decodeInviteCode(decodeURIComponent(fromQuery[1]));
  }
  return null;
}
