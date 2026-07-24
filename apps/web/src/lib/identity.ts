import {
  blackbookFileContents,
  blackbookFilename,
  decryptBlackbook,
  encryptBlackbook,
  fingerprint,
  generateSecretKey,
  getPublicKey,
  parseBlackbookFile,
  type BlackbookOptions,
} from '@1nky/protocol';
import { db, getPref, setPref, type StoredTag } from './db.js';

/** What the rest of the app sees. The secret never leaves this module's callers. */
export interface Tag {
  secret: Uint8Array;
  pubkey: string;
  name: string;
  mark: string;
  createdAt: number;
  backedUp: boolean;
  hasPosted: boolean;
}

function toTag(row: StoredTag): Tag {
  return {
    // idb hands back the stored buffer; normalise so callers always get a
    // plain Uint8Array (structured clone can yield an ArrayBuffer view).
    secret: new Uint8Array(row.secret),
    pubkey: row.pubkey,
    name: row.name,
    mark: fingerprint(row.pubkey),
    createdAt: row.createdAt,
    backedUp: row.backedUp,
    hasPosted: row.hasPosted,
  };
}

/** The stored tag, or null if this device has never had one. */
export async function loadTag(): Promise<Tag | null> {
  const row = await (await db()).get('tag', 'me');
  return row ? toTag(row) : null;
}

async function save(row: StoredTag): Promise<Tag> {
  await (await db()).put('tag', row);
  return toTag(row);
}

/**
 * Make a brand-new tag.
 *
 * Storage only — publishing the kind-0 profile is the caller's job (it needs
 * proof of work and a live connection, neither of which belong in the store).
 */
export async function createTag(name: string): Promise<Tag> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Pick a tag first.');
  const secret = generateSecretKey();
  return save({
    id: 'me',
    secret,
    pubkey: getPublicKey(secret),
    name: trimmed,
    createdAt: Math.floor(Date.now() / 1000),
    backedUp: false,
    hasPosted: false,
  });
}

/**
 * Adopt an existing secret — the restore path.
 *
 * `backedUp` starts true: they are literally holding the backup right now.
 */
export async function adoptTag(secret: Uint8Array, name: string): Promise<Tag> {
  if (secret.length !== 32) throw new Error('That does not look like a blackbook.');
  return save({
    id: 'me',
    secret: new Uint8Array(secret),
    pubkey: getPublicKey(secret),
    name: name.trim() || 'unnamed',
    createdAt: Math.floor(Date.now() / 1000),
    backedUp: true,
    hasPosted: true,
  });
}

async function patch(changes: Partial<StoredTag>): Promise<Tag | null> {
  const row = await (await db()).get('tag', 'me');
  if (!row) return null;
  return save({ ...row, ...changes, id: 'me' });
}

export function renameTag(name: string): Promise<Tag | null> {
  return patch({ name: name.trim() });
}

export function markBackedUp(): Promise<Tag | null> {
  return patch({ backedUp: true });
}

export function markHasPosted(): Promise<Tag | null> {
  return patch({ hasPosted: true });
}

/** Wipes the tag off this device. Used by restore-over and "Hang it up". */
export async function forgetTag(): Promise<void> {
  const store = await db();
  await store.delete('tag', 'me');
  await store.delete('prefs', OWN_POSTS_KEY);
}

// --- Blackbook ---------------------------------------------------------------

export interface BlackbookExport {
  filename: string;
  contents: string;
  /** The bare payload, for the QR. */
  payload: string;
  /** False when the writer skipped the passphrase. */
  locked: boolean;
}

/**
 * Turn a tag into the file the writer walks away with.
 *
 * With a passphrase this is a NIP-49 encrypted payload. Without one there is
 * nothing to encrypt to, so we refuse silently-weak security and instead make
 * the caller show the loud warning — see `UNLOCKED_WARNING`.
 */
export async function exportBlackbook(
  tag: Pick<Tag, 'secret' | 'name'>,
  passphrase: string,
  options: BlackbookOptions = {},
): Promise<BlackbookExport> {
  const trimmed = passphrase.trim();
  if (!trimmed) {
    const raw = bytesToHexLower(tag.secret);
    return {
      filename: blackbookFilename(tag.name),
      contents: [
        blackbookFileContents(tag.name, raw),
        '',
        UNLOCKED_WARNING,
        '',
      ].join('\n'),
      payload: raw,
      locked: false,
    };
  }
  const payload = encryptBlackbook(tag.secret, trimmed, options);
  return {
    filename: blackbookFilename(tag.name),
    contents: blackbookFileContents(tag.name, payload),
    payload,
    locked: true,
  };
}

export const UNLOCKED_WARNING =
  'THIS FILE IS NOT LOCKED. Anyone who opens it becomes you. ' +
  'Do not put it in cloud storage, chat, or email.';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Read a blackbook back. Accepts the whole downloaded file, a bare payload,
 * or the unlocked hex form.
 *
 * @throws with copy-deck-safe messages — never protocol vocabulary.
 */
export function importBlackbook(contents: string, passphrase: string): Uint8Array {
  const cleaned = contents.trim();
  if (!cleaned) throw new Error('Nothing to read.');

  // Unlocked blackbook: bare 32-byte hex, possibly wrapped in the file.
  const unwrapped = unwrapFence(cleaned);
  if (HEX64.test(unwrapped)) return hexToBytes(unwrapped.toLowerCase());

  let payload: string;
  try {
    payload = parseBlackbookFile(cleaned);
  } catch {
    throw new Error('That is not a blackbook.');
  }
  if (!passphrase) throw new Error('This blackbook is locked. Enter the passphrase.');
  try {
    return decryptBlackbook(payload, passphrase);
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

function unwrapFence(contents: string): string {
  const fenced = /-----\s*BEGIN BLACKBOOK\s*-----\s*([\s\S]*?)\s*-----\s*END BLACKBOOK\s*-----/.exec(
    contents,
  );
  return (fenced?.[1] ?? contents).replace(/\s+/g, '');
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Rough passphrase strength, 0–4, for the meter next to the field.
 * Deliberately simple: length dominates, variety helps a little.
 */
export function passphraseStrength(value: string): { score: 0 | 1 | 2 | 3 | 4; hint: string } {
  const length = value.trim().length;
  if (length === 0) return { score: 0, hint: 'No passphrase. Anyone who finds the file is you.' };
  let score = 0;
  if (length >= 8) score++;
  if (length >= 14) score++;
  if (length >= 20) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
  if (classes >= 3 && length >= 10) score++;
  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const hints = [
    'Way too short.',
    'Weak. Make it longer.',
    'Getting there.',
    'Solid.',
    'Strong. Write it down somewhere real.',
  ] as const;
  return { score: clamped, hint: hints[clamped] };
}

// --- Own-post bookkeeping ----------------------------------------------------
// The relay is the source of truth, but "Buff this" and "Hang it up" need to
// know what this device put up without waiting on the indexer.

const OWN_POSTS_KEY = 'own-posts';

export async function rememberOwnPost(id: string): Promise<void> {
  const ids = await getPref<string[]>(OWN_POSTS_KEY, []);
  if (ids.includes(id)) return;
  await setPref(OWN_POSTS_KEY, [id, ...ids].slice(0, 500));
}

export function ownPostIds(): Promise<string[]> {
  return getPref<string[]>(OWN_POSTS_KEY, []);
}
