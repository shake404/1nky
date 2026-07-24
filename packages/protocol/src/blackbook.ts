import { decrypt, encrypt } from 'nostr-tools/nip49';
import { COPY } from './copy.js';

/**
 * scrypt work factor exponent (N = 2^logn). NIP-49's default of 16 costs
 * roughly a second on a phone — the right trade for a file that guards a
 * tag forever.
 */
export const BLACKBOOK_LOGN = 16;

export interface BlackbookOptions {
  /** scrypt log2(N). Lower only for tests. @default 16 */
  logn?: number;
}

/**
 * Encrypt a secret key into a NIP-49 `ncryptsec1...` payload — the contents
 * of the writer's blackbook.
 *
 * Uses nostr-tools' NIP-49 implementation (scrypt + XChaCha20-Poly1305).
 * The key-security byte is left at nostr-tools' default of `0x02`
 * ("client does not track this"), which is honest for a browser client.
 */
export function encryptBlackbook(
  secretKey: Uint8Array,
  passphrase: string,
  options: BlackbookOptions = {},
): string {
  if (secretKey.length !== 32) {
    throw new TypeError('encryptBlackbook: secret key must be 32 bytes');
  }
  if (passphrase.length === 0) {
    throw new TypeError('encryptBlackbook: passphrase must not be empty');
  }
  return encrypt(secretKey, passphrase, options.logn ?? BLACKBOOK_LOGN);
}

/**
 * Decrypt a blackbook payload back into a secret key.
 *
 * @throws if the payload is not an `ncryptsec1...` string or the passphrase
 *         is wrong (the AEAD tag fails).
 */
export function decryptBlackbook(payload: string, passphrase: string): Uint8Array {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('ncryptsec1')) {
    throw new TypeError('decryptBlackbook: payload is not an ncryptsec string');
  }
  return decrypt(trimmed, passphrase);
}

/** True when a string looks like an encrypted blackbook payload. */
export function isBlackbookPayload(value: string): boolean {
  // bech32 data charset: digits minus "1", letters minus "b", "i", "o".
  return /^ncryptsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}$/.test(value.trim());
}

/** Suggested download filename for a writer's blackbook. */
export function blackbookFilename(tag: string): string {
  const safe = tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `1nky-blackbook-${safe || 'tag'}.txt`;
}

/**
 * The human-readable blackbook file the writer downloads.
 *
 * Deliberately plain text: it has to survive being printed, photographed,
 * pasted into a note app, or read out loud. Contains no jargon (hard rule 3)
 * and leads with the warning that matters.
 */
export function blackbookFileContents(tag: string, payload: string): string {
  const cleanTag = tag.trim() || 'unnamed';
  return [
    '1NKY BLACKBOOK',
    '==============',
    '',
    `TAG: ${cleanTag}`,
    '',
    COPY.blackbook.warning,
    '',
    'This file IS your tag. Anyone who has this file and your passphrase can',
    'post as you. Keep it somewhere only you can get to.',
    '',
    'TO GET YOUR TAG BACK:',
    '  1. Go to 1nky.com',
    `  2. Tap "${COPY.tag.restore}"`,
    '  3. Paste the block below and enter your passphrase',
    '',
    '----- BEGIN BLACKBOOK -----',
    payload.trim(),
    '----- END BLACKBOOK -----',
    '',
  ].join('\n');
}

/** Pull the payload back out of a blackbook file. Accepts a bare payload too. */
export function parseBlackbookFile(contents: string): string {
  const fenced = /-----\s*BEGIN BLACKBOOK\s*-----\s*([\s\S]*?)\s*-----\s*END BLACKBOOK\s*-----/.exec(
    contents,
  );
  const candidate = (fenced?.[1] ?? contents).replace(/\s+/g, '');
  if (!isBlackbookPayload(candidate)) {
    throw new TypeError('parseBlackbookFile: no blackbook found in this file');
  }
  return candidate;
}
