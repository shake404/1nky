/**
 * Crew-key sync — a founder's crew keys follow their tag to every device.
 *
 * WHY THIS EXISTS
 *   A crew's secret lives only in the device-local keyring where the crew was
 *   founded or imported, so the same founder on a second device sees no founder
 *   panel. The fix is a self-custodial backup: each held crew secret is
 *   encrypted TO THE OWNER'S OWN TAG and published to the relay as a kind-30078
 *   app-data event keyed by the crew pubkey. Any device logged in as that tag
 *   pulls the backups down, decrypts them, and repopulates its local keyring.
 *
 * WHY IT IS SAFE TO PUBLISH
 *   A crew's kind-30078 definition already carries `founderPubkey` publicly, so
 *   "this writer holds/founded this crew" is not a secret for founders. The one
 *   thing that must never leak — the crew SECRET — rides only inside a nip44
 *   ciphertext encrypted to the owner's own pubkey. `getConversationKey(mySecret,
 *   myPubkey)` is a key only the owner's secret can reproduce, so no one else
 *   (not the relay, not another writer) can decrypt it. Same crypto path as the
 *   private-message layer (`dm.ts`); nothing here is hand-rolled.
 */

import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';

import { KINDS } from './kinds.js';
import type { EventTemplate, Tag } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Ciphertext size ceiling, mirroring `dm.ts`. Applied before nip44 decrypt so
 * an oversized blob off the relay is refused rather than handed to the library.
 */
const MAX_CIPHERTEXT_CHARS = 65_536;

/** The `d`-tag prefix on a kind-30078 crew-key backup: `crewkey:<crewPubkey>`. */
export const CREW_KEY_BACKUP_DTAG_PREFIX = 'crewkey:';

/**
 * The plaintext a backup carries, encrypted to the owner's own tag. Everything
 * a fresh device needs to repopulate its keyring AND its founded-crews pointer:
 * the crew secret (hex), the crew's display name, and the crew pubkey (echoed
 * so a decrypt is self-describing and can be cross-checked against the d-tag).
 */
export interface CrewKeyPayload {
  /** The crew's 32-byte secret, lowercase hex. The one thing that must stay encrypted. */
  secret: string;
  /** The crew's tag name, for the directory listing. */
  name: string;
  /** The crew's own pubkey, lowercase hex. */
  crewPubkey: string;
}

function assertHex64(value: string, what: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new TypeError(`${what}: expected 64-char lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Kind 30078 — a crew-key backup, signed by the OWNER's tag (the caller signs).
 *
 * Parameterized replaceable, keyed `d = "crewkey:<crewPubkey>"`, so re-backing
 * up the same crew replaces rather than accumulates — one row per crew per
 * owner. The content is the opaque nip44 ciphertext from {@link encryptCrewKey};
 * this builder never sees the crew secret in the clear. `ownerPubkey` is
 * validated but not embedded — the signature the caller applies is what records
 * the owner.
 */
export function buildCrewKeyBackup(
  ownerPubkey: string,
  crewPubkey: string,
  ciphertext: string,
): EventTemplate {
  assertHex64(ownerPubkey, 'buildCrewKeyBackup(ownerPubkey)');
  assertHex64(crewPubkey, 'buildCrewKeyBackup(crewPubkey)');
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new TypeError('buildCrewKeyBackup: ciphertext must be a non-empty string');
  }
  const tags: Tag[] = [['d', `${CREW_KEY_BACKUP_DTAG_PREFIX}${crewPubkey}`]];
  return {
    kind: KINDS.APP_DATA,
    tags,
    content: ciphertext,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * nip44 self-encrypt a crew-key payload TO THE OWNER'S OWN TAG.
 *
 * `getConversationKey(ownerSecret, ownerPubkey)` — the exact usage `dm.ts`
 * relies on — yields a key only the owner's secret can reproduce, so the
 * resulting ciphertext is readable by no one else. The returned string is what
 * goes on the wire via {@link buildCrewKeyBackup}.
 */
export function encryptCrewKey(
  ownerSecret: Uint8Array,
  ownerPubkey: string,
  payload: CrewKeyPayload,
): string {
  assertHex64(ownerPubkey, 'encryptCrewKey(ownerPubkey)');
  return nip44Encrypt(JSON.stringify(payload), getConversationKey(ownerSecret, ownerPubkey));
}

function isCrewKeyPayload(value: unknown): value is CrewKeyPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['secret'] === 'string' &&
    HEX64.test(record['secret']) &&
    typeof record['name'] === 'string' &&
    typeof record['crewPubkey'] === 'string' &&
    HEX64.test(record['crewPubkey'])
  );
}

/**
 * Decrypt a crew-key backup with the owner's tag, or `null` on any failure.
 *
 * NEVER throws — the ciphertext comes off a relay socket, so bad size, bad
 * base64, a wrong key, a bad MAC, bad JSON or a malformed payload all fall
 * through as `null`, matching the defensive style of `dm.ts`'s `openLayer`.
 */
export function decryptCrewKey(
  ownerSecret: Uint8Array,
  ownerPubkey: string,
  ciphertext: unknown,
): CrewKeyPayload | null {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) return null;
  if (typeof ownerPubkey !== 'string' || !HEX64.test(ownerPubkey)) return null;

  let plaintext: string;
  try {
    plaintext = nip44Decrypt(ciphertext, getConversationKey(ownerSecret, ownerPubkey));
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isCrewKeyPayload(parsed)) return null;
  return { secret: parsed.secret.toLowerCase(), name: parsed.name, crewPubkey: parsed.crewPubkey.toLowerCase() };
}

/**
 * The crew pubkey + opaque ciphertext of a kind-30078 crew-key backup, or
 * `null` when the event is not one.
 *
 * Same defensive style as `parseModBan`: any other kind, any other `d` value
 * and any malformed crew pubkey fall through as `null`, so the caller can hand
 * it any event off the relay. The ciphertext is NOT decrypted here — that needs
 * the owner's secret and is {@link decryptCrewKey}'s job.
 */
export function parseCrewKeyBackup(event: {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}): { crewPubkey: string; ciphertext: string } | null {
  if (event.kind !== KINDS.APP_DATA) return null;
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!d || !d.startsWith(CREW_KEY_BACKUP_DTAG_PREFIX)) return null;
  const crewPubkey = d.slice(CREW_KEY_BACKUP_DTAG_PREFIX.length).toLowerCase();
  if (!HEX64.test(crewPubkey)) return null;
  if (typeof event.content !== 'string' || event.content.length === 0) return null;
  return { crewPubkey, ciphertext: event.content };
}
